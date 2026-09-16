/**
 * OneBook ELD — live simulator: per-driver state machine + payload builders (dev only).
 *
 * Reads the mock fleet ONCE from the dev DB (assigned vehicle, paired `MOCKPT30-*` device, the
 * latest duty-status record, the vehicle's last raw odometer / engine hours / position) and from
 * then on keeps everything in memory. Every write goes through the real HTTP ingest endpoints
 * (`/ingest/telemetry`, `/ingest/events`, `/ingest/device-status`) exactly like the mobile app —
 * see `index.ts`. Nothing here ever touches a table directly.
 *
 * Realism rules of thumb (tz.md §5.4–5.7, §395):
 *   - DRIVING legs 1–3.5 h at 50–68 mph along a mock corridor (`hos-events.ts` routes), then a
 *     30–45 min OFF break or 15–45 min ON_DUTY stop; ≤ 10.5 h drive / 13.5 h shift, then a
 *     10–14 h rest.  Intermediate log (type 2/1) every 60 min of driving.  Engine power-up /
 *     shutdown records (type 6) around the rest.
 *   - Odometer (raw km) and engine hours are strictly monotonic and continue from the newest
 *     row already in the DB for that vehicle, so the §4.3 anomaly check never fires.
 *   - Timestamps are `Date.now()` at send time — never in the future (B-044) and never > 10 min
 *     away from the server clock (§7.3 rule 5), so no malfunction `T`.
 */
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { distanceMi } from '../../../src/common/units/location';
import { offsetMs } from '../../../src/modules/hos/engine/timezone';
import { computeChecksum } from '../../../src/modules/ingest/checksum';
import { createRng, MOCK_DEVICE_PREFIX, MOCK_USERNAME_PREFIX, type MockRng } from '../context';
import {
  buildRoute,
  CORRIDORS,
  corridorsForTimezone,
  metroLoop,
  positionAt,
  type Route,
  type Waypoint,
} from '../generators/hos-events';

export type Duty = 'OFF' | 'SB' | 'D' | 'ON';

const DUTY_CODE: Record<Duty, number> = { OFF: 1, SB: 2, D: 3, ON: 4 };
const CODE_DUTY: Record<number, Duty> = { 1: 'OFF', 2: 'SB', 3: 'D', 4: 'ON' };

/** UUID prefix of every event the simulator writes ("live" in hex) — greppable, never random. */
export const LIVE_EVENT_UUID_PREFIX = '6c697665-';

const MIN = 60_000;
const HOUR = 60 * MIN;
const KM_PER_MI = 1.609344;

/** `--tempo=N` divides every planned status duration by N (demo mode: more transitions). */
let tempo = 1;
export function setTempo(n: number): void {
  tempo = n > 0 ? n : 1;
}
/** A planned duration of `a..b` minutes, scaled by the tempo. */
function minutes(rng: MockRng, a: number, b: number): number {
  return Math.round((rng.int(a, b) * MIN) / tempo);
}

const MAX_DRIVE_PER_SHIFT_MS = 10.5 * HOUR;
const MAX_SHIFT_MS = 13.5 * HOUR;
const INTERMEDIATE_LOG_EVERY_MS = 60 * MIN;
/** Motion is integrated over real elapsed time, but never more than this per tick (laptop sleep). */
const MAX_STEP_MS = 5 * MIN;

export interface SimDriver {
  driverId: string;
  username: string;
  timezone: string;
  vehicleId: string;
  unitNumber: string;
  deviceSerial: string;

  status: Duty;
  statusSince: number;
  /** When the current status is planned to end (ms epoch). */
  plannedEnd: number;
  /** True when the current OFF/SB is an end-of-shift rest (engine off, long). */
  resting: boolean;
  shiftStart: number | null;
  /** Driving accumulated in this shift as simulated here (ms). */
  driveMs: number;

  lastMotionAt: number;
  lastIntermediateAt: number;
  lastHeartbeatAt: number;
  /** False until the "app" has reported BLE CONNECTED for this device (§7.6), once per run. */
  bleAnnounced: boolean;

  route: Route;
  routeMi: number;
  rawKm: number;
  engineHours: number;
  idleHours: number;
  fuelPct: number;
  lat: number;
  lon: number;
  headingDeg: number;
  speedMph: number;
  locationName: string;

  rng: MockRng;
}

export interface EventPayload {
  uuid: string;
  eventType: number;
  eventCode: number;
  eventDateTime: string;
  timezoneOffset: number;
  recordStatus: number;
  recordOrigin: number;
  wasStoredOnDevice: boolean;
  latitude: number;
  longitude: number;
  locationName: string;
  locationSource: number;
  distanceSinceLastValidCoords: number;
  rawDeviceOdometerKm: number;
  totalEngineHours: number;
  annotation?: string;
  checksum: string;
}

export interface TelemetryPayload {
  time: string;
  latitude: number;
  longitude: number;
  speedKmh: number;
  headingDeg: number;
  odometerKm: number;
  engineHours: number;
  idleHours: number;
  engineOn: boolean;
  rpm: number;
  gear: string;
  seatBelt: boolean;
  fuelPct: number;
  coolantTempC: number;
  ambientTempC: number;
  voltage: number;
  busType: 'J1939';
  isTransition: boolean;
}

export interface TickJob {
  driver: SimDriver;
  telemetry: TelemetryPayload | null;
  events: EventPayload[];
  heartbeat: boolean;
  /** First upload of the run: report the BLE link as CONNECTED (§7.6). */
  announceBle: boolean;
  transitions: string[];
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

interface FleetRow {
  driverId: string;
  username: string;
  timezone: string;
  vehicleId: string;
  unitNumber: string;
  deviceSerial: string;
  eventCode: number | null;
  eventDateTime: Date | null;
  eventLat: number | null;
  eventLon: number | null;
  eventLocationName: string | null;
  lastRawKm: number | null;
  lastEngineHours: number | null;
  tpTime: Date | null;
  tpOdometerMi: number | null;
  tpEngineHours: number | null;
  tpIdleHours: number | null;
  tpLat: number | null;
  tpLon: number | null;
  tpHeading: number | null;
  tpFuelPct: number | null;
  odometerOffsetMi: number;
}

/**
 * One query, three LATERAL probes riding the `(driverId, eventDateTime)` / `(vehicleId,
 * eventDateTime)` / `(vehicleId, time)` indexes. Only mock drivers with an ACTIVE assigned mock
 * vehicle that has a paired `MOCKPT30-*` device qualify — that is exactly what the API's
 * `resolveContext` demands before it attributes anything to a driver (§7.4 / untrusted
 * `deviceSerial`+`vehicleId` claims).
 */
export async function loadFleet(prisma: PrismaClient, seed: number, maxDrivers: number): Promise<SimDriver[]> {
  const rows = await prisma.$queryRaw<FleetRow[]>(Prisma.sql`
    SELECT d.id AS "driverId", d.username, d."homeTerminalTimezone" AS timezone,
           v.id AS "vehicleId", v."unitNumber", v."odometerOffsetMi", dv.serial AS "deviceSerial",
           le."eventCode", le."eventDateTime", le.latitude::float8 AS "eventLat", le.longitude::float8 AS "eventLon",
           le."locationName" AS "eventLocationName",
           vo."rawDeviceOdometerKm" AS "lastRawKm", vo."totalEngineHours"::float8 AS "lastEngineHours",
           tp."time" AS "tpTime", tp."odometerMi" AS "tpOdometerMi", tp."engineHours"::float8 AS "tpEngineHours",
           tp."idleHours"::float8 AS "tpIdleHours", tp.latitude::float8 AS "tpLat", tp.longitude::float8 AS "tpLon",
           tp."headingDeg" AS "tpHeading", tp."fuelPct" AS "tpFuelPct"
    FROM "Driver" d
    JOIN "Vehicle" v ON v.id = d."assignedVehicleId"
    JOIN "Device" dv ON dv."vehicleId" = v.id
    LEFT JOIN LATERAL (
      SELECT "eventCode", "eventDateTime", latitude, longitude, "locationName"
      FROM "EldEvent" e
      WHERE e."driverId" = d.id AND e."eventType" = 1 AND e."recordStatus" = 1
      ORDER BY e."eventDateTime" DESC LIMIT 1
    ) le ON true
    LEFT JOIN LATERAL (
      SELECT "rawDeviceOdometerKm", "totalEngineHours"
      FROM "EldEvent" e
      WHERE e."vehicleId" = v.id AND e."rawDeviceOdometerKm" IS NOT NULL
      ORDER BY e."eventDateTime" DESC LIMIT 1
    ) vo ON true
    LEFT JOIN LATERAL (
      SELECT "time", "odometerMi", "engineHours", "idleHours", latitude, longitude, "headingDeg", "fuelPct"
      FROM "TelemetryPoint" t
      WHERE t."vehicleId" = v.id
      ORDER BY t."time" DESC LIMIT 1
    ) tp ON true
    WHERE d.username LIKE ${`${MOCK_USERNAME_PREFIX}%`}
      AND d.status = 'ACTIVE' AND v.status = 'ACTIVE'
      AND dv.serial LIKE ${`${MOCK_DEVICE_PREFIX}%`}
    ORDER BY d.username`);

  const now = Date.now();
  const sims = rows.map((row, i) => initDriver(row, now, createRng(seed + i * 7919)));
  // Keep the units that are already moving first, so a capped run still shows a lively map.
  const rank: Record<Duty, number> = { D: 0, ON: 1, SB: 2, OFF: 3 };
  sims.sort((a, b) => rank[a.status] - rank[b.status] || a.username.localeCompare(b.username));
  return maxDrivers > 0 ? sims.slice(0, maxDrivers) : sims;
}

function initDriver(row: FleetRow, now: number, rng: MockRng): SimDriver {
  const status: Duty = (row.eventCode !== null && CODE_DUTY[row.eventCode]) || 'OFF';
  const statusSince = row.eventDateTime ? Math.min(row.eventDateTime.getTime(), now) : now - 12 * HOUR;

  // Position: newest telemetry fix, else the newest located duty record, else the corridor start.
  const corridors = corridorsForTimezone(row.timezone);
  const fallback = CORRIDORS[corridors[0]][0];
  const lat = row.tpLat ?? row.eventLat ?? fallback.lat;
  const lon = row.tpLon ?? row.eventLon ?? fallback.lon;
  const { route, routeMi, nearest } = snapToRoute(corridors, { lat, lon }, rng);
  const pos = positionAt(route, routeMi);

  // Odometer / engine hours: continue from whichever stored source is furthest along.
  const tpRawKm = row.tpOdometerMi !== null ? (row.tpOdometerMi - row.odometerOffsetMi) * KM_PER_MI : 0;
  const rawKm = Math.max(row.lastRawKm ?? 0, tpRawKm, 1000);
  const engineHours = Math.max(row.lastEngineHours ?? 0, row.tpEngineHours ?? 0, rawKm / KM_PER_MI / 38);

  const sim: SimDriver = {
    driverId: row.driverId,
    username: row.username,
    timezone: row.timezone,
    vehicleId: row.vehicleId,
    unitNumber: row.unitNumber,
    deviceSerial: row.deviceSerial,
    status,
    statusSince,
    plannedEnd: now,
    resting: false,
    shiftStart: null,
    driveMs: 0,
    lastMotionAt: now,
    lastIntermediateAt: now,
    // Stagger the first heartbeat so a fleet does not phase-lock on one tick.
    lastHeartbeatAt: now - rng.int(0, 9) * MIN,
    bleAnnounced: false,
    route,
    routeMi,
    rawKm,
    engineHours,
    idleHours: row.tpIdleHours ?? Math.round(engineHours * 0.18),
    fuelPct: row.tpFuelPct ?? rng.int(35, 95),
    lat: pos.lat,
    lon: pos.lon,
    headingDeg: row.tpHeading ?? rng.int(0, 359),
    speedMph: 0,
    locationName: nearest ? pos.name : (row.eventLocationName ?? pos.name),
    rng,
  };
  planInitial(sim, now);
  return sim;
}

/**
 * Pick the corridor whose polyline passes closest to the unit's last fix and start from that
 * offset. A unit far from every corridor (short-haul metro drivers) gets a loop around its fix,
 * named after the nearest corridor city so `locationName` stays plausible.
 */
function snapToRoute(
  corridorNames: string[],
  at: { lat: number; lon: number },
  rng: MockRng,
): { route: Route; routeMi: number; nearest: boolean } {
  let best: { route: Route; routeMi: number; dist: number; city: Waypoint } | null = null;
  for (const name of corridorNames) {
    const route = buildRoute(CORRIDORS[name]);
    for (let mi = 0; mi <= route.length; mi += 5) {
      const p = positionAt(route, mi);
      const dist = distanceMi(p, at);
      if (!best || dist < best.dist) {
        const cityIdx = route.points.findIndex((w) => w.name === p.city);
        best = { route, routeMi: mi, dist, city: route.points[Math.max(cityIdx, 0)] };
      }
    }
  }
  if (!best) throw new Error('simulator: no corridors configured');
  if (best.dist <= 60) return { route: best.route, routeMi: best.routeMi, nearest: true };
  const loop = metroLoop({ name: best.city.name, lat: at.lat, lon: at.lon }, rng);
  return { route: loop, routeMi: 0, nearest: false };
}

/** Plans the first transition from whatever state the dataset left the driver in. */
function planInitial(sim: SimDriver, now: number): void {
  const { rng } = sim;
  const elapsed = now - sim.statusSince;
  switch (sim.status) {
    case 'D':
      sim.shiftStart = Math.max(sim.statusSince, now - 2 * HOUR);
      sim.plannedEnd = now + minutes(rng, 20, 150);
      sim.speedMph = rng.int(50, 68);
      break;
    case 'ON':
      sim.shiftStart = Math.max(sim.statusSince, now - HOUR);
      sim.plannedEnd = now + minutes(rng, 5, 30);
      break;
    default:
      sim.resting = elapsed >= 2 * HOUR;
      sim.plannedEnd =
        elapsed >= 10 * HOUR ? now + minutes(rng, 1, 240) : now + Math.round((10 * HOUR - elapsed) / tempo) + minutes(rng, 0, 180);
  }
}

// ---------------------------------------------------------------------------------------------
// Ticking
// ---------------------------------------------------------------------------------------------

/** Advances one driver to `now` and returns what the "app" should upload this tick. */
export function step(sim: SimDriver, now: number): TickJob {
  const events: EventPayload[] = [];
  const transitions: string[] = [];

  integrateMotion(sim, now);

  if (now >= sim.plannedEnd) {
    const from = sim.status;
    const to = chooseNext(sim, now);
    events.push(...transition(sim, to, now));
    transitions.push(`${from} -> ${to}`);
  }

  if (sim.status === 'D' && now - sim.lastIntermediateAt >= INTERMEDIATE_LOG_EVERY_MS) {
    // §395.26 hourly intermediate log while driving (type 2 / code 1, automatic).
    events.push(buildEvent(sim, 2, 1, 1, now));
    sim.lastIntermediateAt = now;
  }

  const telemetry = sim.status === 'D' || sim.status === 'ON' ? buildTelemetry(sim, now, events.length > 0) : null;
  const heartbeat = now - sim.lastHeartbeatAt >= 10 * MIN;
  if (heartbeat) sim.lastHeartbeatAt = now;
  const announceBle = !sim.bleAnnounced;
  sim.bleAnnounced = true;

  return { driver: sim, telemetry, events, heartbeat, announceBle, transitions };
}

function integrateMotion(sim: SimDriver, now: number): void {
  const dtMs = Math.min(Math.max(now - sim.lastMotionAt, 0), MAX_STEP_MS);
  sim.lastMotionAt = now;
  if (dtMs === 0) return;
  const dtH = dtMs / HOUR;
  if (sim.status === 'D') {
    sim.speedMph = clamp(sim.speedMph + sim.rng.int(-4, 4), 50, 68);
    const miles = sim.speedMph * dtH;
    const prev = { lat: sim.lat, lon: sim.lon };
    sim.routeMi += miles;
    const pos = positionAt(sim.route, sim.routeMi);
    sim.lat = pos.lat;
    sim.lon = pos.lon;
    sim.locationName = pos.name;
    sim.headingDeg = bearing(prev, pos) ?? sim.headingDeg;
    sim.rawKm += miles * KM_PER_MI;
    sim.engineHours += dtH;
    sim.fuelPct = Math.max(4, sim.fuelPct - miles / 6.5 / 2.4); // ~6.5 mpg, ~240 gal tank
    sim.driveMs += dtMs;
  } else if (sim.status === 'ON') {
    sim.speedMph = 0;
    sim.engineHours += dtH;
    sim.idleHours += dtH;
  } else {
    sim.speedMph = 0;
  }
}

function chooseNext(sim: SimDriver, now: number): Duty {
  const { rng } = sim;
  const shiftMs = sim.shiftStart ? now - sim.shiftStart : 0;
  const exhausted = sim.driveMs >= MAX_DRIVE_PER_SHIFT_MS || shiftMs >= MAX_SHIFT_MS;
  switch (sim.status) {
    case 'D':
      if (exhausted) return rng.chance(0.35) ? 'SB' : 'OFF';
      return rng.chance(0.55) ? 'ON' : rng.chance(0.85) ? 'OFF' : 'SB';
    case 'ON':
      if (exhausted) return 'OFF';
      return rng.chance(0.9) ? 'D' : 'OFF';
    default:
      return 'ON';
  }
}

/** Applies a duty change: the §395 records it produces and the next planned end. */
function transition(sim: SimDriver, to: Duty, now: number): EventPayload[] {
  const { rng } = sim;
  const from = sim.status;
  const events: EventPayload[] = [];
  const shiftMs = sim.shiftStart ? now - sim.shiftStart : 0;
  const exhausted = sim.driveMs >= MAX_DRIVE_PER_SHIFT_MS || shiftMs >= MAX_SHIFT_MS;

  // Leaving a rest: engine power-up (type 6/1) a few seconds before the ON_DUTY record.
  if ((from === 'OFF' || from === 'SB') && sim.resting) {
    events.push(buildEvent(sim, 6, 1, 1, now - 10_000));
    sim.fuelPct = rng.chance(0.3) ? rng.int(80, 98) : sim.fuelPct; // sometimes fuelled overnight
  }

  const rest = (to === 'OFF' || to === 'SB') && (exhausted || (from === 'ON' && rng.chance(0.3)));
  const origin = to === 'D' || (to === 'ON' && from === 'D') ? 1 : 2;
  const annotation =
    origin === 2 ? (rest ? (to === 'SB' ? 'Sleeper berth' : 'Off duty - end of shift') : to === 'ON' ? 'Pre-trip inspection' : '30 min break') : undefined;
  events.push(buildEvent(sim, 1, DUTY_CODE[to], origin, now - 5_000, annotation));

  // Entering a long rest: engine shutdown (type 6/3) right after the OFF/SB record.
  if (rest) events.push(buildEvent(sim, 6, 3, 1, now - 2_000));

  sim.status = to;
  sim.statusSince = now;
  sim.resting = rest;
  switch (to) {
    case 'D':
      sim.plannedEnd = now + minutes(rng, 60, 210);
      sim.speedMph = rng.int(50, 68);
      sim.lastIntermediateAt = now;
      if (!sim.shiftStart) sim.shiftStart = now;
      break;
    case 'ON':
      sim.speedMph = 0;
      sim.plannedEnd = now + minutes(rng, 15, 45);
      if (!sim.shiftStart) {
        sim.shiftStart = now;
        sim.driveMs = 0;
      }
      break;
    default:
      sim.speedMph = 0;
      if (rest) {
        sim.plannedEnd = now + minutes(rng, 600, 840); // 10–14 h
        sim.shiftStart = null;
        sim.driveMs = 0;
      } else {
        sim.plannedEnd = now + minutes(rng, 30, 45);
      }
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------------

function buildEvent(
  sim: SimDriver,
  eventType: number,
  eventCode: number,
  recordOrigin: number,
  atMs: number,
  annotation?: string,
): EventPayload {
  const at = new Date(Math.floor(atMs / 1000) * 1000);
  const base = {
    uuid: liveUuid(`${sim.driverId}:${eventType}:${eventCode}:${at.getTime()}`),
    eventType,
    eventCode,
    eventDateTime: at.toISOString(),
    timezoneOffset: Math.round(offsetMs(sim.timezone, at) / MIN),
    recordStatus: 1,
    recordOrigin,
    // Raw coordinates — the server coarsens them before storage (§7.3 rule 9).
    latitude: round(sim.lat, 6),
    longitude: round(sim.lon, 6),
    rawDeviceOdometerKm: Math.round(sim.rawKm),
    totalEngineHours: round(sim.engineHours, 2),
  };
  return {
    ...base,
    wasStoredOnDevice: false,
    locationName: sim.locationName.slice(0, 60),
    locationSource: 1,
    distanceSinceLastValidCoords: 0,
    ...(annotation ? { annotation } : {}),
    checksum: computeChecksum(base),
  };
}

function buildTelemetry(sim: SimDriver, now: number, isTransition: boolean): TelemetryPayload {
  const { rng } = sim;
  const driving = sim.status === 'D';
  return {
    time: new Date(now).toISOString(),
    latitude: round(sim.lat, 6),
    longitude: round(sim.lon, 6),
    speedKmh: round(sim.speedMph * KM_PER_MI, 1),
    headingDeg: Math.round(sim.headingDeg) % 360,
    odometerKm: round(sim.rawKm, 1),
    engineHours: round(sim.engineHours, 2),
    idleHours: round(sim.idleHours, 2),
    engineOn: true,
    rpm: driving ? rng.int(1250, 1650) : rng.int(640, 760),
    gear: driving ? (sim.speedMph > 55 ? '10' : '9') : 'N',
    seatBelt: driving,
    fuelPct: Math.round(sim.fuelPct),
    coolantTempC: driving ? rng.int(86, 94) : rng.int(78, 88),
    ambientTempC: rng.int(14, 29),
    voltage: round(rng.float(13.8, 14.4), 1),
    busType: 'J1939',
    isTransition,
  };
}

/** Deterministic, prefix-tagged uuid — a retried upload of the same record is a duplicate. */
export function liveUuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${LIVE_EVENT_UUID_PREFIX}${h.slice(0, 4)}-4${h.slice(4, 7)}-${'89ab'[parseInt(h[7], 16) % 4]}${h.slice(8, 11)}-${h.slice(11, 23)}`;
}

function bearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number | null {
  const dLat = to.lat - from.lat;
  const dLon = (to.lon - from.lon) * Math.cos((from.lat * Math.PI) / 180);
  if (Math.abs(dLat) < 1e-7 && Math.abs(dLon) < 1e-7) return null;
  return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function summarize(sims: SimDriver[]): Record<Duty, number> {
  const out: Record<Duty, number> = { D: 0, ON: 0, SB: 0, OFF: 0 };
  for (const s of sims) out[s.status] += 1;
  return out;
}
