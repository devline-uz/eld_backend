/**
 * Pure helpers for the `ingest` mock generator (telemetry, device state, malfunction/diagnostic
 * records, DTCs). No Prisma in here — every rule is unit-tested in `ingest.helpers.spec.ts`.
 *
 * Hard rules honoured (backend/tz.md §4, §5.5-5.7, §7):
 *  - every stored coordinate is coarsened to 1 mile BEFORE it leaves this module (no raw fix);
 *  - unit maths only through `src/common/units`;
 *  - nothing is ever dated after `to` (no future timestamps).
 */
import { coarsenLocation, KM_TO_MI } from '../../../src/common/units';
import type { MockRng } from '../context';

export const MIN_MS = 60_000;
export const HOUR_MS = 60 * MIN_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Telemetry cadence: dense for the last 14 days, sparse before (disk budget, see decisions.md). */
export const RECENT_WINDOW_MS = 14 * DAY_MS;
export const RECENT_INTERVAL_MS = 5 * MIN_MS;
export const OLD_INTERVAL_MS = 60 * MIN_MS;

export function sampleIntervalMs(at: number, to: number): number {
  return to - at <= RECENT_WINDOW_MS ? RECENT_INTERVAL_MS : OLD_INTERVAL_MS;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Float great-circle miles (the units helper rounds to whole miles, too coarse for interpolation). */
export function haversineMi(a: LatLon, b: LatLon): number {
  const R_KM = 6371.0088;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h))) * KM_TO_MI;
}

export function bearingDeg(a: LatLon, b: LatLon): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Destination point from `a` travelling `miles` on `bearing` (flat-earth, fine for < 200 mi). */
export function project(a: LatLon, bearing: number, miles: number): LatLon {
  const rad = (bearing * Math.PI) / 180;
  const dLat = (miles * Math.cos(rad)) / 69.0;
  const dLon = (miles * Math.sin(rad)) / (69.0 * Math.max(0.2, Math.cos((a.lat * Math.PI) / 180)));
  return { lat: a.lat + dLat, lon: a.lon + dLon };
}

/**
 * A "plausible road": the straight chord bowed sideways by `bow` (fraction of the chord length,
 * signed) as a half sine — real routes are never great-circle lines, and a bow keeps the heading
 * changing along the leg while both ends still land exactly on the recorded event locations.
 */
export function routePoint(a: LatLon, b: LatLon, frac: number, bow: number): LatLon {
  const f = Math.min(1, Math.max(0, frac));
  const lat = a.lat + (b.lat - a.lat) * f;
  const lon = a.lon + (b.lon - a.lon) * f;
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  // perpendicular of the chord in a locally-isotropic frame
  const dx = (b.lon - a.lon) * cos;
  const dy = b.lat - a.lat;
  const off = bow * Math.sin(Math.PI * f);
  return { lat: lat + dx * off, lon: lon + (-dy * off) / cos };
}

/** 1-mile coarsening (ON/D/SB/OFF, §7.3 rule 9) rounded to the Decimal(9,6) column. */
export function coarsen1Mi(p: LatLon): LatLon {
  const c = coarsenLocation(p, 'ONE_MILE');
  return { lat: Math.round(c.lat * 1e6) / 1e6, lon: Math.round(c.lon * 1e6) / 1e6 };
}

// ---------------------------------------------------------------------------------------------
// Driving segments from the hos generator's EldEvents
// ---------------------------------------------------------------------------------------------

export interface SourceEvent {
  driverId: string;
  vehicleId: string | null;
  eventType: number;
  eventCode: number;
  at: number;
  timezoneOffset: number;
  lat: number | null;
  lon: number | null;
  miles: number | null;
  engineHours: number | null;
}

export interface Waypoint extends LatLon {
  at: number;
  miles: number | null;
  engineHours: number | null;
}

export interface DrivingSegment {
  driverId: string;
  vehicleId: string;
  start: number;
  /** End of driving: the next duty-status/logout/shutdown record, or `to` when still driving. */
  end: number;
  open: boolean;
  timezoneOffset: number;
  waypoints: Waypoint[];
  /** Duty code that ended the segment (1 OFF, 2 SB, 4 ON) or null (logout/shutdown/open). */
  nextDutyCode: number | null;
  /** When the following non-driving period ends (next D start or `to`) — bounds idle/parked points. */
  restUntil: number;
}

const DUTY = 1;
const INTERMEDIATE = 2;
const LOGIN_LOGOUT = 5;
const ENGINE_POWER = 6;
const D_CODE = 3;

function located(e: SourceEvent): e is SourceEvent & { lat: number; lon: number } {
  return e.lat !== null && e.lon !== null && Number.isFinite(e.lat) && Number.isFinite(e.lon);
}

/**
 * Splits one driver's chronologically sorted events into driving segments. A segment starts at a
 * duty-status D record carrying a vehicle and ends at the next duty-status record, a logout
 * (5/2) or an engine shutdown (6/3,6/4). Intermediate logs (type 2) and the end record become
 * waypoints when they carry a location. Segments with no located waypoint are dropped.
 */
export function buildDrivingSegments(events: SourceEvent[], to: number): DrivingSegment[] {
  const out: DrivingSegment[] = [];
  let cur: DrivingSegment | null = null;
  const close = (end: number, code: number | null, endEvent: SourceEvent | null): void => {
    if (!cur) return;
    cur.end = Math.min(end, to);
    cur.nextDutyCode = code;
    if (endEvent && located(endEvent) && endEvent.at <= to) {
      cur.waypoints.push(toWaypoint(endEvent));
    }
    if (cur.waypoints.length > 0 && cur.end > cur.start) out.push(cur);
    cur = null;
  };
  for (const e of events) {
    if (e.at > to) break;
    const isDuty = e.eventType === DUTY;
    const isEnd =
      isDuty ||
      (e.eventType === LOGIN_LOGOUT && e.eventCode === 2) ||
      (e.eventType === ENGINE_POWER && (e.eventCode === 3 || e.eventCode === 4));
    if (cur && isEnd) close(e.at, isDuty ? e.eventCode : null, e);
    if (isDuty && e.eventCode === D_CODE && e.vehicleId) {
      cur = {
        driverId: e.driverId,
        vehicleId: e.vehicleId,
        start: e.at,
        end: to,
        open: false,
        timezoneOffset: e.timezoneOffset,
        waypoints: located(e) ? [toWaypoint(e)] : [],
        nextDutyCode: null,
        restUntil: to,
      };
    } else if (cur && e.eventType === INTERMEDIATE && located(e)) {
      cur.waypoints.push(toWaypoint(e));
    }
  }
  if (cur) {
    const open: DrivingSegment = cur;
    open.open = true;
    open.end = to;
    if (open.waypoints.length > 0 && open.end > open.start) out.push(open);
  }
  // rest window after each segment = until the next segment of the same driver starts
  for (let i = 0; i < out.length; i += 1) out[i].restUntil = i + 1 < out.length ? out[i + 1].start : to;
  return out;
}

function toWaypoint(e: SourceEvent & { lat: number; lon: number }): Waypoint {
  return { at: e.at, lat: e.lat, lon: e.lon, miles: e.miles, engineHours: e.engineHours };
}

// ---------------------------------------------------------------------------------------------
// Telemetry synthesis
// ---------------------------------------------------------------------------------------------

export type BusTypeName = 'J1939' | 'J1708' | 'OBD_II';

export interface TelemetryRowOut {
  time: Date;
  vehicleId: string;
  driverId: string | null;
  latitude: number;
  longitude: number;
  speedMph: number;
  headingDeg: number | null;
  odometerMi: number;
  engineHours: number;
  idleHours: number;
  engineOn: boolean;
  rpm: number;
  gear: string | null;
  seatBelt: boolean;
  loadPct: number;
  fuelPct: number;
  fuelPct2: number | null;
  defPct: number;
  fuelRateGph: number;
  fuelEconomyMpg: number | null;
  totalFuelUsedGal: number;
  totalFuelIdleGal: number;
  oilPressurePsi: number;
  oilPct: number;
  oilTempC: number;
  coolantPct: number;
  coolantTempC: number;
  intakeTempC: number;
  ambientTempC: number;
  transmOilTempC: number;
  dtcCount: number;
  busType: BusTypeName;
  voltage: number;
}

/** Running per-vehicle ECU counters, carried across segments in time order. */
export interface VehicleState {
  vehicleId: string;
  odometer: number;
  engineHours: number;
  idleHours: number;
  fuelPct: number;
  defPct: number;
  totalFuelGal: number;
  idleFuelGal: number;
  dualTank: boolean;
  tankGal: number;
  busType: BusTypeName;
  lastAt: number;
  lastPos: LatLon | null;
  lastHeading: number | null;
  /** DTC activity intervals, for `dtcCount`. */
  dtcIntervals: Array<[number, number]>;
  /** Primary-key guard: (time, vehicleId). */
  times: Set<number>;
}

export function newVehicleState(
  vehicleId: string,
  rng: MockRng,
  base: { odometer: number; engineHours: number; busType: BusTypeName | null },
): VehicleState {
  return {
    vehicleId,
    odometer: base.odometer,
    engineHours: base.engineHours,
    idleHours: Math.round(base.engineHours * rng.float(0.18, 0.3) * 100) / 100,
    fuelPct: rng.int(55, 95),
    defPct: rng.int(50, 95),
    totalFuelGal: Math.round(base.odometer / rng.float(6.2, 6.9)),
    idleFuelGal: Math.round(base.engineHours * rng.float(0.15, 0.3)),
    dualTank: rng.chance(0.4),
    tankGal: rng.pick([150, 200, 240]),
    busType: base.busType ?? 'J1939',
    lastAt: 0,
    lastPos: null,
    lastHeading: null,
    dtcIntervals: [],
    times: new Set<number>(),
  };
}

export function ambientTempC(lat: number, at: number): number {
  const month = new Date(at).getUTCMonth(); // 0..11
  const seasonal = -Math.cos(((month - 0.5) / 12) * 2 * Math.PI); // -1 Jan .. +1 Jul
  const hour = new Date(at).getUTCHours();
  const diurnal = Math.sin(((hour - 12) / 24) * 2 * Math.PI) * 5; // ~US afternoon peak around 21 UTC
  return Math.round(14 + seasonal * 13 - (lat - 33) * 0.7 + diurnal);
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function activeDtcs(state: VehicleState, at: number): number {
  let n = 0;
  for (const [a, b] of state.dtcIntervals) if (at >= a && at < b) n += 1;
  return n;
}

type Mode = 'DRIVE' | 'IDLE' | 'OFF';

/** One ECU sample. Advances the vehicle counters from `state.lastAt` to `at` first. */
export function makeRow(
  state: VehicleState,
  rng: MockRng,
  p: { at: number; pos: LatLon; driverId: string | null; mode: Mode; speedMph: number; headingDeg: number | null; odometer?: number },
): TelemetryRowOut | null {
  // Fixes only ever move forward in time per vehicle: overlapping segments on one truck can never
  // produce a backwards odometer / engine-hour step in time order (bugs.md).
  if (state.times.has(p.at) || (state.lastAt > 0 && p.at <= state.lastAt)) return null;
  const dtH = state.lastAt > 0 ? Math.max(0, (p.at - state.lastAt) / HOUR_MS) : 0;
  const prevOdo = state.odometer;
  if (p.odometer !== undefined) state.odometer = Math.max(state.odometer, Math.floor(p.odometer));
  const miles = state.odometer - prevOdo;
  if (p.mode !== 'OFF') {
    state.engineHours = r2(state.engineHours + Math.min(dtH, 1.5));
    if (p.mode === 'IDLE') {
      state.idleHours = r2(state.idleHours + Math.min(dtH, 1.5));
      state.idleFuelGal = r2(state.idleFuelGal + Math.min(dtH, 1.5) * 0.9);
      state.totalFuelGal = r2(state.totalFuelGal + Math.min(dtH, 1.5) * 0.9);
    }
  }
  const gal = miles / 6.5;
  state.totalFuelGal = r2(state.totalFuelGal + gal);
  state.fuelPct -= (gal / state.tankGal) * 100;
  state.defPct -= miles * 0.004;
  if (state.fuelPct < 18) state.fuelPct = rng.int(92, 100); // fuel stop
  if (state.defPct < 12) state.defPct = rng.int(90, 100);
  state.lastAt = p.at;
  state.times.add(p.at);

  const c = coarsen1Mi(p.pos);
  state.lastPos = c;
  if (p.headingDeg !== null) state.lastHeading = p.headingDeg;
  const amb = ambientTempC(c.lat, p.at);
  const drive = p.mode === 'DRIVE' && p.speedMph > 0;
  const on = p.mode !== 'OFF';
  const fuelPct = Math.max(0, Math.min(100, Math.round(state.fuelPct)));
  return {
    time: new Date(p.at),
    vehicleId: state.vehicleId,
    driverId: p.driverId,
    latitude: c.lat,
    longitude: c.lon,
    speedMph: Math.max(0, Math.round(p.speedMph)),
    headingDeg: p.headingDeg ?? state.lastHeading,
    odometerMi: state.odometer,
    engineHours: state.engineHours,
    idleHours: state.idleHours,
    engineOn: on,
    rpm: drive ? rng.int(1150, 1650) : on ? rng.int(620, 720) : 0,
    gear: drive ? String(p.speedMph > 50 ? rng.int(11, 13) : rng.int(6, 10)) : on ? 'N' : null,
    seatBelt: drive || (on && rng.chance(0.5)),
    loadPct: drive ? rng.int(35, 85) : on ? rng.int(10, 18) : 0,
    fuelPct,
    fuelPct2: state.dualTank ? Math.max(0, Math.min(100, fuelPct + rng.int(-3, 3))) : null,
    defPct: Math.max(0, Math.min(100, Math.round(state.defPct))),
    fuelRateGph: drive ? r2(rng.float(6, 11)) : on ? r2(rng.float(0.7, 1.1)) : 0,
    fuelEconomyMpg: drive ? r2(rng.float(5.8, 7.4)) : null,
    totalFuelUsedGal: state.totalFuelGal,
    totalFuelIdleGal: state.idleFuelGal,
    oilPressurePsi: drive ? Math.round(rng.float(40, 55) * 10) / 10 : on ? Math.round(rng.float(22, 32) * 10) / 10 : 0,
    oilPct: rng.int(82, 100),
    oilTempC: drive ? rng.int(95, 110) : on ? rng.int(78, 92) : Math.max(amb, amb + rng.int(0, 15)),
    coolantPct: rng.int(90, 100),
    coolantTempC: drive ? rng.int(85, 97) : on ? rng.int(75, 88) : amb + rng.int(0, 20),
    intakeTempC: amb + (on ? rng.int(8, 20) : rng.int(0, 4)),
    ambientTempC: amb,
    transmOilTempC: drive ? rng.int(70, 95) : on ? rng.int(55, 70) : amb + rng.int(0, 10),
    dtcCount: activeDtcs(state, p.at),
    busType: state.busType,
    voltage: on ? Math.round(rng.float(13.7, 14.3) * 10) / 10 : Math.round(rng.float(12.3, 12.8) * 10) / 10,
  };
}

export interface SegmentOptions {
  to: number;
  /** Stop live fixes this long before `to` (a "stale" unit whose app lost the PT30). */
  staleCutMs?: number;
}

interface Leg {
  a: Waypoint;
  b: Waypoint;
  bow: number;
  miles: number;
  startMiles: number;
}

/**
 * Telemetry for one driving segment: an optional pre-trip idle fix, one fix per cadence tick
 * along the bowed route between consecutive waypoints (odometer/speed consistent with the
 * waypoint odometers), a stop fix at the end, then idle (next status ON) or engine-off (OFF/SB)
 * fixes inside the following rest window. An open segment (still driving now) is extrapolated
 * from the last waypoint on its last heading, never beyond `to`.
 */
export function segmentTelemetry(seg: DrivingSegment, state: VehicleState, rng: MockRng, opt: SegmentOptions): TelemetryRowOut[] {
  const rows: TelemetryRowOut[] = [];
  const push = (r: TelemetryRowOut | null): void => {
    if (r) rows.push(r);
  };
  const to = opt.to;
  const wps = seg.waypoints.slice().sort((x, y) => x.at - y.at);
  const first = wps[0];

  // Odometer is anchored to the recorded miles of each waypoint and NEVER re-based on the running
  // counter: hos can put two drivers in D on one truck at once, and re-basing the second driver's
  // segment onto the first one's counter compounded into thousands of phantom miles (bugs.md).
  // `makeRow` keeps the stored value monotonic (it plateaus instead of stepping back).
  const miles0 = first.miles ?? state.odometer;

  // Older than the dense window, a segment only gets its route ticks and the stop fix (disk budget).
  const dense = to - seg.start <= RECENT_WINDOW_MS;

  // Pre-trip idle (engine warm-up) right before driving starts.
  if (rng.chance(0.6) && dense) {
    const t = seg.start - rng.int(3, 12) * MIN_MS;
    if (t > state.lastAt && t <= to) {
      push(makeRow(state, rng, { at: t, pos: first, driverId: seg.driverId, mode: 'IDLE', speedMph: 0, headingDeg: null, odometer: miles0 }));
    }
  }

  // Open segment: extrapolate a synthetic end waypoint so the truck is moving right now.
  if (seg.open) {
    const last = wps[wps.length - 1];
    const prev = wps.length > 1 ? wps[wps.length - 2] : null;
    const heading = prev && haversineMi(prev, last) > 0.5 ? bearingDeg(prev, last) : rng.int(0, 359);
    const hours = Math.max(0, (to - last.at) / HOUR_MS);
    const mph = rng.float(56, 68);
    const dist = Math.min(hours, 1.5) * mph;
    const end = project(last, heading, dist);
    wps.push({ at: to, lat: end.lat, lon: end.lon, miles: last.miles !== null ? last.miles + dist * 1.05 : null, engineHours: null });
  } else if (wps[wps.length - 1].at < seg.end) {
    // end record carried no location: stop where the last waypoint was
    const last = wps[wps.length - 1];
    wps.push({ ...last, at: seg.end });
  }

  const legs: Leg[] = [];
  let runMiles = miles0;
  for (let i = 0; i + 1 < wps.length; i += 1) {
    const a = wps[i];
    const b = wps[i + 1];
    const chord = haversineMi(a, b);
    const recorded = a.miles !== null && b.miles !== null && b.miles >= a.miles ? b.miles - a.miles : null;
    const m = recorded ?? chord * 1.2;
    const startMiles = a.miles ?? runMiles;
    legs.push({ a, b, bow: chord > 3 ? rng.float(-0.12, 0.12) : 0, miles: m, startMiles });
    runMiles = startMiles + m;
  }

  const liveUntil = seg.open ? to - (opt.staleCutMs ?? 0) : seg.end;
  let t = seg.start;
  for (const leg of legs) {
    const dur = leg.b.at - leg.a.at;
    if (dur <= 0) continue;
    const avgMph = leg.miles / (dur / HOUR_MS);
    while (t < leg.b.at && t < liveUntil) {
      const frac = (t - leg.a.at) / dur;
      const pos = routePoint(leg.a, leg.b, frac, leg.bow);
      const ahead = routePoint(leg.a, leg.b, Math.min(1, frac + 0.02), leg.bow);
      const heading = haversineMi(pos, ahead) > 0.01 ? bearingDeg(pos, ahead) : state.lastHeading;
      const speed = avgMph < 3 ? rng.int(0, 8) : Math.min(78, avgMph * rng.float(0.85, 1.12));
      push(
        makeRow(state, rng, {
          at: t,
          pos,
          driverId: seg.driverId,
          mode: 'DRIVE',
          speedMph: t === seg.start ? Math.min(speed, rng.int(5, 15)) : speed,
          headingDeg: heading,
          odometer: leg.startMiles + leg.miles * frac,
        }),
      );
      t += sampleIntervalMs(t, to);
    }
  }

  const lastLeg = legs[legs.length - 1];
  const endPos: LatLon = lastLeg ? lastLeg.b : first;
  const endMiles = lastLeg ? lastLeg.startMiles + lastLeg.miles : miles0;

  if (seg.open) {
    // still driving: one fix at the live edge (unless the unit went stale)
    if (!opt.staleCutMs) {
      const at = Math.max(state.lastAt + 1000, to - rng.int(5, 90) * 1000);
      const pos = lastLeg ? routePoint(lastLeg.a, lastLeg.b, (at - lastLeg.a.at) / Math.max(1, lastLeg.b.at - lastLeg.a.at), lastLeg.bow) : endPos;
      push(
        makeRow(state, rng, {
          at,
          pos,
          driverId: seg.driverId,
          mode: 'DRIVE',
          speedMph: rng.int(52, 71),
          headingDeg: state.lastHeading,
          odometer: endMiles - (to - at) / HOUR_MS * 60,
        }),
      );
    }
    rows.sort((x, y) => x.time.getTime() - y.time.getTime());
    return rows;
  }

  // Stop fix at the segment end.
  if (seg.end <= to) {
    push(makeRow(state, rng, { at: seg.end, pos: endPos, driverId: seg.driverId, mode: 'IDLE', speedMph: 0, headingDeg: null, odometer: endMiles }));
  }

  // Rest window: idle while ON, engine off otherwise.
  if (!dense) return rows.sort((x, y) => x.time.getTime() - y.time.getTime());
  const restEnd = Math.min(seg.restUntil, to);
  if (seg.nextDutyCode === 4) {
    // Still ON now (no later driving): idle up to the live edge, even when the hos records stopped
    // a few hours before this run — only the last 3 h are sampled.
    const liveTail = seg.restUntil >= to && to - seg.end < 12 * HOUR_MS;
    const step = liveTail ? RECENT_INTERVAL_MS : 15 * MIN_MS;
    const maxPts = liveTail ? 36 : 2;
    let n = 0;
    for (let at = liveTail ? Math.max(seg.end + step, to - 3 * HOUR_MS) : seg.end + step; at < restEnd && n < maxPts; at += step, n += 1) {
      push(makeRow(state, rng, { at, pos: endPos, driverId: seg.driverId, mode: 'IDLE', speedMph: 0, headingDeg: null }));
    }
    if (liveTail && restEnd === to) {
      push(makeRow(state, rng, { at: to - rng.int(10, 120) * 1000, pos: endPos, driverId: seg.driverId, mode: 'IDLE', speedMph: 0, headingDeg: null }));
    }
  } else {
    const at = seg.end + rng.int(2, 10) * MIN_MS;
    if (at < restEnd) push(makeRow(state, rng, { at, pos: endPos, driverId: seg.driverId, mode: 'OFF', speedMph: 0, headingDeg: null }));
  }
  // keep the primary-key guard monotonic even when a late fix was pushed before a later one
  rows.sort((x, y) => x.time.getTime() - y.time.getTime());
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Vehicle odometer / engine-hour timeline (from the hos generator's records only)
// ---------------------------------------------------------------------------------------------

export interface TimelinePoint {
  at: number;
  value: number;
}

/**
 * Value at `at` interpolated between the surrounding timeline points, rounded DOWN to `digits`
 * and clamped to [prev, next]: a record inserted between two monotone records stays monotone
 * with both neighbours. Before the first point -> first value; after the last -> last value.
 * `points` must be sorted by `at`.
 */
export function valueAt(points: TimelinePoint[], at: number, digits: number): number | null {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (at <= points[0].at) return points[0].value;
  if (at >= points[hi].at) return points[hi].value;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].at <= at) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const raw = a.value + (b.value - a.value) * ((at - a.at) / Math.max(1, b.at - a.at));
  const f = 10 ** digits;
  const down = Math.floor(raw * f + 1e-9) / f;
  return Math.min(Math.max(down, Math.min(a.value, b.value)), Math.max(a.value, b.value));
}

// ---------------------------------------------------------------------------------------------
// Malfunctions / diagnostics (eventType 7) and DTCs
// ---------------------------------------------------------------------------------------------

export interface CodePlan {
  kind: 'malfunction' | 'diagnostic';
  code: string;
  reason: string;
  loggedAt: number;
  clearedAt: number | null;
}

const DIAG_WEIGHTS: Array<[string, number, string]> = [
  ['1', 22, 'Power data diagnostic: ELD powered late after engine on'],
  ['2', 20, 'Engine sync diagnostic: ECM data lost > 5 s'],
  ['3', 26, 'Missing required data elements (location/odometer)'],
  ['4', 10, 'Data transfer diagnostic: periodic check failed'],
  ['5', 16, 'Unidentified driving records > 30 min in 24 h'],
  ['6', 6, 'Other ELD diagnostic: BLE gateway reconnect storm'],
];
const MALF_WEIGHTS: Array<[string, number, string]> = [
  ['P', 15, 'Power compliance: > 30 min driving time lost in 24 h'],
  ['E', 20, 'Engine sync compliance: ECM link lost > 30 min in 24 h'],
  ['T', 10, 'Timing compliance: device clock drift > 10 min from UTC'],
  ['L', 30, 'Positioning compliance: no valid fix > 60 min in 24 h'],
  ['R', 10, 'Data recording compliance: device storage full'],
  ['S', 15, 'Data transfer compliance: 3 consecutive checks failed'],
];

export function weighted(rng: MockRng, table: Array<[string, number, string]>): [string, string] {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let x = rng.next() * total;
  for (const [code, w, reason] of table) {
    x -= w;
    if (x < 0) return [code, reason];
  }
  const [code, , reason] = table[table.length - 1];
  return [code, reason];
}

export const DIAG_PER_SEGMENT = 0.02;
export const MALF_PER_SEGMENT = 0.0008;
/** Still-active share for codes logged within the last 7 days. */
export const ACTIVE_DIAG_SHARE = 0.35;
export const ACTIVE_MALF_SHARE = 0.8;

/** Plans malfunction/diagnostic windows for one segment. Clears never land after `to`. */
export function planCodes(seg: DrivingSegment, rng: MockRng, to: number): CodePlan[] {
  const out: CodePlan[] = [];
  const dur = seg.end - seg.start;
  if (dur <= 0) return out;
  const recent = (at: number): boolean => to - at <= 7 * DAY_MS;
  if (rng.chance(DIAG_PER_SEGMENT)) {
    const [code, reason] = weighted(rng, DIAG_WEIGHTS);
    const loggedAt = seg.start + Math.floor(dur * rng.float(0.05, 0.95));
    const clearIn = rng.chance(0.7) ? rng.int(2, 45) * MIN_MS : rng.int(1, 8) * HOUR_MS;
    let clearedAt: number | null = loggedAt + clearIn;
    if (clearedAt > to || (recent(loggedAt) && rng.chance(ACTIVE_DIAG_SHARE))) clearedAt = null;
    out.push({ kind: 'diagnostic', code, reason, loggedAt, clearedAt });
  }
  if (rng.chance(MALF_PER_SEGMENT)) {
    const [code, reason] = weighted(rng, MALF_WEIGHTS);
    const loggedAt = seg.start + Math.floor(dur * rng.float(0.1, 0.9));
    let clearedAt: number | null = loggedAt + rng.int(6, 144) * HOUR_MS;
    if (clearedAt > to || (recent(loggedAt) && rng.chance(ACTIVE_MALF_SHARE))) clearedAt = null;
    out.push({ kind: 'malfunction', code, reason, loggedAt, clearedAt });
  }
  return out;
}

export interface DtcSpec {
  spn: number;
  fmi: number;
  source: string;
  severity: 'Critical' | 'Warning' | 'Info';
  text: string;
}

/** Real J1939 SPN/FMI pairs; the table has no severity column, so it prefixes `description`. */
export const DTC_CATALOG: DtcSpec[] = [
  { spn: 110, fmi: 0, source: 'ECM', severity: 'Critical', text: 'Engine coolant temperature above normal' },
  { spn: 100, fmi: 1, source: 'ECM', severity: 'Critical', text: 'Engine oil pressure below normal' },
  { spn: 111, fmi: 1, source: 'ECM', severity: 'Critical', text: 'Coolant level low' },
  { spn: 5246, fmi: 0, source: 'ACM', severity: 'Critical', text: 'SCR operator inducement - engine derate' },
  { spn: 157, fmi: 18, source: 'ECM', severity: 'Warning', text: 'Fuel rail pressure below normal' },
  { spn: 3226, fmi: 4, source: 'ACM', severity: 'Warning', text: 'Aftertreatment outlet NOx sensor voltage low' },
  { spn: 3719, fmi: 16, source: 'ACM', severity: 'Warning', text: 'DPF soot load above normal' },
  { spn: 4364, fmi: 18, source: 'ACM', severity: 'Warning', text: 'SCR conversion efficiency low' },
  { spn: 1761, fmi: 1, source: 'ACM', severity: 'Warning', text: 'DEF tank level low' },
  { spn: 3251, fmi: 0, source: 'ACM', severity: 'Warning', text: 'DPF differential pressure high' },
  { spn: 168, fmi: 1, source: 'ECM', severity: 'Warning', text: 'Battery potential below normal' },
  { spn: 94, fmi: 1, source: 'ECM', severity: 'Warning', text: 'Fuel delivery pressure low' },
  { spn: 105, fmi: 0, source: 'ECM', severity: 'Warning', text: 'Intake manifold temperature high' },
  { spn: 177, fmi: 0, source: 'TCM', severity: 'Warning', text: 'Transmission oil temperature high' },
  { spn: 1487, fmi: 7, source: 'ABS', severity: 'Warning', text: 'ABS modulator not responding' },
  { spn: 102, fmi: 2, source: 'ECM', severity: 'Info', text: 'Intake manifold pressure signal erratic' },
  { spn: 190, fmi: 2, source: 'ECM', severity: 'Info', text: 'Engine speed signal erratic' },
  { spn: 639, fmi: 9, source: 'VCU', severity: 'Info', text: 'J1939 datalink abnormal update rate' },
  { spn: 597, fmi: 2, source: 'ECM', severity: 'Info', text: 'Brake switch signal erratic' },
  { spn: 791, fmi: 5, source: 'ECM', severity: 'Info', text: 'Fan clutch circuit open' },
];

export interface DtcRow {
  vehicleId: string;
  spn: number;
  fmi: number;
  occurrence: number;
  source: string;
  description: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  clearedAt: Date | null;
}

/**
 * DTC history for one vehicle. ~45 % of units have codes; ~20 % of codes are still active
 * (seen within the last 2 weeks). Never two open rows for the same (spn, fmi) — mirrors
 * `DtcService.upsertCode`.
 */
export function planDtcs(vehicleId: string, rng: MockRng, from: number, to: number): DtcRow[] {
  const rows: DtcRow[] = [];
  if (!rng.chance(0.45)) return rows;
  const specs = rng.shuffle(DTC_CATALOG).slice(0, rng.int(1, 4));
  for (const spec of specs) {
    const active = rng.chance(0.2);
    const repeats = active ? 1 : rng.int(1, 2);
    for (let i = 0; i < repeats; i += 1) {
      const first = active ? to - rng.int(1, 14) * DAY_MS - rng.int(0, 23) * HOUR_MS : from + Math.floor(rng.next() * (to - from - 3 * DAY_MS));
      const last = Math.min(to - rng.int(1, 60) * MIN_MS, first + rng.int(0, active ? 13 : 20) * DAY_MS + rng.int(0, 23) * HOUR_MS);
      const cleared = active ? null : Math.min(to, last + rng.int(1, 72) * HOUR_MS);
      rows.push({
        vehicleId,
        spn: spec.spn,
        fmi: spec.fmi,
        occurrence: rng.int(1, active ? 40 : 15),
        source: spec.source,
        description: `${spec.severity}: ${spec.text}`,
        firstSeenAt: new Date(Math.min(first, last)),
        lastSeenAt: new Date(last),
        clearedAt: cleared !== null ? new Date(Math.max(cleared, last)) : null,
      });
      if (active) break;
    }
  }
  return rows;
}

/** PT30 firmware mix: mostly current, some one release behind, a few below the L108 minimum. */
export function pickFirmware(rng: MockRng): string {
  const x = rng.next();
  if (x < 0.62) return 'L113';
  if (x < 0.82) return 'L112';
  if (x < 0.93) return 'L110';
  if (x < 0.97) return 'L108';
  return 'L105';
}
