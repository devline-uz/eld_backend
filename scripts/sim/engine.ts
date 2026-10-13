/**
 * Driver simulator — pure per-driver scenario engine (no I/O, deterministic for a given seed).
 *
 * It reproduces what the real driver app does between the PT30 and the API:
 *  - the PT30's own records: engine power-up / shut-down (6/1, 6/3) + raw EV_ENGINE_ON/OFF;
 *  - the app's `EldEventGenerator` (mobile/lib/core/eld/eld_event_generator.dart):
 *      * automatic D (1/3, recordOrigin 1) on the first sample above 5 mph (App. A 4.4.1.1),
 *      * 0 mph for 5 min in D -> idle prompt, unanswered 1 more min -> ON (1/4, origin 1) (4.4.1.2),
 *      * an intermediate log (2/1) for every hour in motion (4.5.1.2);
 *  - the driver's own taps: ON for pre-trip, OFF for a 30-min break / end of shift
 *    (`POST /mobile/duty-status`, driver-entered — never D, which the server refuses);
 *  - Virtual Dashboard telemetry downsampled to one point per `pointEverySec`, transitions
 *    (start / stop) never dropped (§7.5).
 *
 * All timestamps are real wall-clock instants: the engine only ever advances `simAt` up to the
 * `now` it is given (no time compression).
 */
import { randomUUID } from 'node:crypto';
import { computeChecksum } from '../../src/modules/ingest/checksum';
import { advance, findRoute, positionAt, type RoutePosition } from './routes';

export type Duty = 'OFF' | 'SB' | 'ON' | 'D';
export type StopKind = 'FUEL' | 'BREAK' | 'END';
export type Phase =
  | 'REST' // off duty, engine off, parked
  | 'PRETRIP' // on duty, engine on, parked
  | 'DRIVING' // moving (or accelerating away)
  | 'STOPPING' // decelerating towards a planned stop, still D
  | 'STOPPED_D' // 0 mph, still D, waiting for the 5+1 min auto-ON
  | 'FUEL' // on duty at the pump
  | 'BREAK_ON' // auto-ON recorded, driver about to tap OFF
  | 'BREAK_OFF' // 30-min break off duty
  | 'READY' // back on duty after the break, about to pull out
  | 'POSTTRIP'; // end-of-shift inspection, on duty

export interface EngineOptions {
  /** Telemetry downsampling while the engine runs (contract: 60 s). */
  pointEverySec: number;
  /** Telemetry cadence while the engine is off (PT30 periodic). */
  idlePointEverySec: number;
  /** Pre-trip length for the FIRST shift: real 10-15 min, or 1-3 min with quick start. */
  quickStart: boolean;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  pointEverySec: 60,
  idlePointEverySec: 240,
  quickStart: false,
};

export interface TelemetryPoint {
  time: string;
  latitude: number;
  longitude: number;
  speedKmh: number;
  headingDeg: number;
  odometerKm: number;
  engineHours: number;
  engineOn: boolean;
  rpm: number;
  gear: number;
  seatBelt: boolean;
  loadPct: number;
  fuelPct: number;
  coolantTempC: number;
  oilPressureKpa: number;
  voltage: number;
  gpsLocked: boolean;
  gpsSatellites: number;
  gpsDop: number;
  gpsAgeSec: number;
  busType: 'J1939';
  isTransition: boolean;
}

export interface EldEventPayload {
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
  rawDeviceOdometerKm: number;
  totalEngineHours: number;
  checksum: string;
}

export interface DeviceEventPayload {
  type: string;
  seq: number;
  occurredAt: string;
  live: boolean;
  latitude: number;
  longitude: number;
  headingDeg: number;
  gpsLocked: boolean;
  gpsSatellites: number;
  odometerKm: number;
  engineHours: number;
  speedKmh: number;
  rpm: number;
}

export type SimAction =
  | { kind: 'point'; point: TelemetryPoint }
  | { kind: 'event'; event: EldEventPayload }
  | { kind: 'deviceEvent'; event: DeviceEventPayload }
  | { kind: 'duty'; status: 'OFF' | 'SB' | 'ON'; at: string; lat: number; lon: number };

export interface DriverSim {
  routeId: string;
  dir: 1 | -1;
  distMi: number;
  tz: string;
  violation: boolean;
  rng: number;
  simAt: number;
  phase: Phase;
  phaseUntil: number | null;
  stopKind: StopKind | null;
  duty: Duty;
  engineOn: boolean;
  speedMph: number;
  cruiseMph: number;
  slowUntil: number | null;
  slowMph: number;
  odometerKm: number;
  engineHours: number;
  fuelPct: number;
  lastPointAt: number | null;
  intermediateAnchor: number | null;
  shiftStartAt: number | null;
  driveSecShift: number;
  driveSecSinceBreak: number;
  driveSecSinceStop: number;
  nextStopAfterSec: number;
  nextStop: StopKind;
  deviceSeq: number;
  shiftsStarted: number;
  /** Set by the CLI for `--quick-start`: the next pre-trip is 1–3 min (once per run). */
  quickStartPending?: boolean;
}

const MPH_TO_KMH = 1.609344;
const SUBSTEP_MS = 5_000;
const H = 3600;
const MIN_MS = 60_000;
/** App. A 4.3.1.2 — 5 mph. */
export const MOTION_THRESHOLD_MPH = 5;
/** 4.4.1.2 — 5 min prompt + 1 min unanswered. */
export const AUTO_ON_AFTER_MS = 6 * MIN_MS;

// ---------------------------------------------------------------------------- randomness

/** mulberry32 step; state is persisted so restarts stay deterministic. */
export function rand(d: { rng: number }): number {
  d.rng = (d.rng + 0x6d2b79f5) >>> 0;
  let t = d.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function between(d: { rng: number }, lo: number, hi: number): number {
  return lo + (hi - lo) * rand(d);
}

// ---------------------------------------------------------------------------- time helpers

const dtfCache = new Map<string, Intl.DateTimeFormat>();

/** Minutes east of UTC for `tz` at `atMs` (EST -> -300), the app's `timeZoneOffset.inMinutes`. */
export function tzOffsetMin(tz: string, atMs: number): number {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, dtf);
  }
  const at = Math.floor(atMs / 1000) * 1000;
  const p = Object.fromEntries(dtf.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - at) / MIN_MS);
}

/** Second-precision ISO (the checksum canonical form drops milliseconds anyway). */
export function isoSec(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------- init

export interface InitInput {
  slot: number;
  routeId: string;
  startDistMi: number;
  dir: 1 | -1;
  odometerKm: number;
  tz: string;
  violation: boolean;
  /** When the first shift starts (pre-trip begins). */
  shiftStartAt: number;
  /** Engine clock start; `simAt` begins here. */
  simAt: number;
  seed: number;
}

export function initDriver(input: InitInput): DriverSim {
  const d: DriverSim = {
    routeId: input.routeId,
    dir: input.dir,
    distMi: input.startDistMi,
    tz: input.tz,
    violation: input.violation,
    rng: input.seed >>> 0,
    simAt: input.simAt,
    phase: 'REST',
    phaseUntil: input.shiftStartAt,
    stopKind: null,
    duty: 'OFF',
    engineOn: false,
    speedMph: 0,
    cruiseMph: 0,
    slowUntil: null,
    slowMph: 0,
    odometerKm: input.odometerKm,
    engineHours: 0,
    fuelPct: 0,
    lastPointAt: null,
    intermediateAnchor: null,
    shiftStartAt: null,
    driveSecShift: 0,
    driveSecSinceBreak: 0,
    driveSecSinceStop: 0,
    nextStopAfterSec: 0,
    nextStop: 'FUEL',
    deviceSeq: 0,
    shiftsStarted: 0,
  };
  d.cruiseMph = between(d, CRUISE_MIN_MPH, CRUISE_MAX_MPH);
  d.engineHours = round(between(d, 3000, 12000), 2);
  d.fuelPct = Math.round(between(d, 55, 95));
  findRoute(d.routeId); // fail fast on a bad id
  return d;
}

// ---------------------------------------------------------------------------- payload builders

function pos(d: DriverSim): RoutePosition {
  return positionAt(findRoute(d.routeId), d.distMi, d.dir);
}

function rpmOf(d: DriverSim): number {
  if (!d.engineOn) return 0;
  if (d.speedMph < 1) return 650 + Math.round(rand(d) * 40);
  return Math.round(1100 + d.speedMph * 6 + rand(d) * 60);
}

export function makePoint(d: DriverSim, atMs: number, isTransition: boolean): TelemetryPoint {
  const p = pos(d);
  const moving = d.speedMph > 0.5;
  return {
    time: isoSec(atMs),
    latitude: round(p.lat, 6),
    longitude: round(p.lon, 6),
    speedKmh: round(d.speedMph * MPH_TO_KMH, 1),
    headingDeg: p.headingDeg,
    odometerKm: round(d.odometerKm, 1),
    engineHours: round(d.engineHours, 2),
    engineOn: d.engineOn,
    rpm: rpmOf(d),
    gear: moving ? Math.min(12, Math.max(1, Math.round(d.speedMph / 6))) : 0,
    seatBelt: d.engineOn,
    loadPct: d.engineOn ? (moving ? Math.round(between(d, 35, 80)) : 12) : 0,
    fuelPct: Math.round(d.fuelPct),
    coolantTempC: d.engineOn ? Math.round(between(d, 84, 92)) : 30,
    oilPressureKpa: d.engineOn ? Math.round(between(d, 260, 340)) : 0,
    voltage: round(d.engineOn ? between(d, 13.7, 14.2) : between(d, 12.4, 12.7), 1),
    gpsLocked: true,
    gpsSatellites: Math.round(between(d, 8, 13)),
    gpsDop: round(between(d, 0.8, 1.6), 1),
    gpsAgeSec: 0,
    busType: 'J1939',
    isTransition,
  };
}

export function makeEvent(d: DriverSim, eventType: number, eventCode: number, atMs: number): EldEventPayload {
  const p = pos(d);
  const base = {
    uuid: randomUUID(),
    eventType,
    eventCode,
    eventDateTime: isoSec(atMs),
    timezoneOffset: tzOffsetMin(d.tz, atMs),
    recordStatus: 1,
    // App. A automatic record (the PT30's own, or the app's EldEventGenerator).
    recordOrigin: 1,
    wasStoredOnDevice: false,
    latitude: round(p.lat, 6),
    longitude: round(p.lon, 6),
    rawDeviceOdometerKm: Math.round(d.odometerKm),
    totalEngineHours: round(d.engineHours, 2),
  };
  return { ...base, checksum: computeChecksum(base) };
}

function makeDeviceEvent(d: DriverSim, type: string, atMs: number): DeviceEventPayload {
  const p = pos(d);
  d.deviceSeq += 1;
  return {
    type,
    seq: d.deviceSeq,
    occurredAt: isoSec(atMs),
    live: true,
    latitude: round(p.lat, 6),
    longitude: round(p.lon, 6),
    headingDeg: p.headingDeg,
    gpsLocked: true,
    gpsSatellites: 10,
    odometerKm: round(d.odometerKm, 1),
    engineHours: round(d.engineHours, 2),
    speedKmh: round(d.speedMph * MPH_TO_KMH, 1),
    rpm: rpmOf(d),
  };
}

function duty(d: DriverSim, status: 'OFF' | 'SB' | 'ON', atMs: number): SimAction {
  const p = pos(d);
  d.duty = status;
  return { kind: 'duty', status, at: isoSec(atMs), lat: round(p.lat, 6), lon: round(p.lon, 6) };
}

// ---------------------------------------------------------------------------- planning

const NORMAL = { maxDriveSec: 10.5 * H, maxShiftSec: 13.5 * H, breakBySec: 7.5 * H, restSec: 10 * H };
const VIOLATION = { maxDriveSec: 12.5 * H, maxShiftSec: 15.5 * H, breakBySec: Infinity, restSec: 10 * H };

function limits(d: DriverSim) {
  return d.violation ? VIOLATION : NORMAL;
}

/** Chooses the next planned stop, counted in driving seconds from now. */
export function planNextStop(d: DriverSim): void {
  const l = limits(d);
  const seg = between(d, 2 * H, 3.5 * H);
  const remainingDrive = Math.max(0, l.maxDriveSec - d.driveSecShift);
  const untilBreak = Math.max(0, l.breakBySec - d.driveSecSinceBreak);
  d.driveSecSinceStop = 0;
  if (seg >= remainingDrive) {
    d.nextStop = 'END';
    d.nextStopAfterSec = remainingDrive;
  } else if (seg >= untilBreak) {
    d.nextStop = 'BREAK';
    d.nextStopAfterSec = untilBreak;
  } else {
    // Violation drivers only ever fuel (15 min ON never satisfies the 30-min break).
    d.nextStop = d.violation || rand(d) < 0.5 ? 'FUEL' : 'BREAK';
    d.nextStopAfterSec = seg;
  }
}

// ---------------------------------------------------------------------------- stepping

function startShift(d: DriverSim, at: number, opts: EngineOptions, out: SimAction[]): void {
  d.engineOn = true;
  d.shiftStartAt = at;
  d.driveSecShift = 0;
  d.driveSecSinceBreak = 0;
  out.push({ kind: 'event', event: makeEvent(d, 6, 1, at) }); // engine power-up (PT30 record)
  out.push({ kind: 'deviceEvent', event: makeDeviceEvent(d, 'EV_ENGINE_ON', at) });
  out.push(duty(d, 'ON', at)); // driver taps ON DUTY for the pre-trip
  emitPoint(d, at, true, out);
  const first = d.shiftsStarted === 0 || d.quickStartPending === true;
  d.quickStartPending = false;
  d.shiftsStarted += 1;
  const preMin = first && opts.quickStart ? between(d, 1, 3) : between(d, 10, 15);
  d.phase = 'PRETRIP';
  d.phaseUntil = at + preMin * MIN_MS;
  planNextStop(d);
}

function beginDriving(d: DriverSim): void {
  d.phase = 'DRIVING';
  d.phaseUntil = null;
  d.stopKind = null;
}

function emitPoint(d: DriverSim, at: number, transition: boolean, out: SimAction[]): void {
  out.push({ kind: 'point', point: makePoint(d, at, transition) });
  d.lastPointAt = at;
}

/** Phase timers that fire at `d.simAt`. */
function onTimer(d: DriverSim, opts: EngineOptions, out: SimAction[]): void {
  const at = d.simAt;
  switch (d.phase) {
    case 'REST':
      startShift(d, at, opts, out);
      return;
    case 'PRETRIP':
    case 'READY':
      beginDriving(d);
      return;
    case 'FUEL':
      d.fuelPct = Math.round(between(d, 92, 99));
      planNextStop(d);
      beginDriving(d);
      return;
    case 'STOPPED_D': {
      // 4.4.1.2 — prompt unanswered: the app records ON (1/4, automatic).
      out.push({ kind: 'event', event: makeEvent(d, 1, 4, at) });
      d.duty = 'ON';
      d.intermediateAnchor = null;
      const kind = d.stopKind ?? 'FUEL';
      if (kind === 'FUEL') {
        d.phase = 'FUEL';
        d.phaseUntil = at + 9 * MIN_MS; // 15 min stop in total
      } else if (kind === 'BREAK') {
        d.phase = 'BREAK_ON';
        d.phaseUntil = at + MIN_MS;
      } else {
        d.phase = 'POSTTRIP';
        d.phaseUntil = at + between(d, 8, 12) * MIN_MS;
      }
      return;
    }
    case 'BREAK_ON':
      out.push(duty(d, 'OFF', at));
      d.phase = 'BREAK_OFF';
      d.phaseUntil = at + between(d, 30.5, 34) * MIN_MS;
      return;
    case 'BREAK_OFF':
      out.push(duty(d, 'ON', at));
      d.driveSecSinceBreak = 0;
      planNextStop(d);
      d.phase = 'READY';
      d.phaseUntil = at + between(d, 1, 3) * MIN_MS;
      return;
    case 'POSTTRIP':
      endShift(d, at, out);
      d.phase = 'REST';
      d.phaseUntil = at + limits(d).restSec + between(d, 0, 30) * MIN_MS;
      return;
    default:
      d.phaseUntil = null;
  }
}

function endShift(d: DriverSim, at: number, out: SimAction[]): void {
  d.engineOn = false;
  d.speedMph = 0;
  out.push({ kind: 'event', event: makeEvent(d, 6, 3, at) }); // engine shut-down
  out.push({ kind: 'deviceEvent', event: makeDeviceEvent(d, 'EV_ENGINE_OFF', at) });
  out.push(duty(d, 'OFF', at));
  emitPoint(d, at, true, out);
  d.shiftStartAt = null;
}

const CRUISE_MIN_MPH = 52;
const CRUISE_MAX_MPH = 58;

function targetSpeed(d: DriverSim, at: number, dtSec: number): number {
  if (d.phase === 'STOPPING') return 0;
  if (d.phase !== 'DRIVING') return 0;
  if (d.slowUntil !== null && at < d.slowUntil) return d.slowMph;
  d.slowUntil = null;
  // Older state files carry a 57–68 mph cruise; keep every truck in the 50–60 mph band.
  if (d.cruiseMph < CRUISE_MIN_MPH || d.cruiseMph > CRUISE_MAX_MPH) {
    d.cruiseMph = between(d, CRUISE_MIN_MPH, CRUISE_MAX_MPH);
  }
  // ~2 slowdowns per hour (traffic, work zones, grades).
  if (rand(d) < (dtSec / H) * 2) {
    d.slowMph = between(d, 42, 49);
    d.slowUntil = at + between(d, 2, 6) * MIN_MS;
    return d.slowMph;
  }
  return d.cruiseMph + (rand(d) - 0.5) * 4;
}

/** One sub-step of `dtSec` ending at `at`. */
function integrate(d: DriverSim, dtSec: number, at: number, opts: EngineOptions, out: SimAction[]): void {
  const target = targetSpeed(d, at, dtSec);
  const before = d.speedMph;
  if (d.speedMph < target) d.speedMph = Math.min(target, d.speedMph + 1.2 * dtSec);
  else d.speedMph = Math.max(target, d.speedMph - 2.0 * dtSec);
  if (d.speedMph < 0.3 && target === 0) d.speedMph = 0;
  // Live Fleet shows the last point: send one as soon as the truck reaches cruise, so the
  // ~6 mph departure point does not linger on the map for a whole point interval.
  if (d.phase === 'DRIVING' && before < CRUISE_MIN_MPH - 2 && d.speedMph >= CRUISE_MIN_MPH - 2) {
    emitPoint(d, at, true, out);
  }

  const avgMph = (before + d.speedMph) / 2;
  const deltaMi = (avgMph * dtSec) / H;
  if (deltaMi > 0) {
    const next = advance(findRoute(d.routeId), d.distMi, d.dir, deltaMi);
    d.distMi = next.distMi;
    d.dir = next.dir;
    d.odometerKm += deltaMi * MPH_TO_KMH;
    d.fuelPct = Math.max(8, d.fuelPct - deltaMi * 0.07);
  }
  if (d.engineOn) d.engineHours += dtSec / H;
  if (d.duty === 'D') {
    d.driveSecShift += dtSec;
    d.driveSecSinceBreak += dtSec;
    d.driveSecSinceStop += dtSec;
  }

  // 4.4.1.1 — automatic D on the first sample above 5 mph.
  if (d.duty !== 'D' && d.speedMph > MOTION_THRESHOLD_MPH) {
    d.duty = 'D';
    d.intermediateAnchor = at;
    out.push({ kind: 'event', event: makeEvent(d, 1, 3, at) });
    emitPoint(d, at, true, out);
  }

  // 4.5.1.2 — intermediate log every hour of driving with nothing else recorded.
  if (d.duty === 'D' && d.intermediateAnchor !== null) {
    while (at >= d.intermediateAnchor + H * 1000) {
      d.intermediateAnchor += H * 1000;
      out.push({ kind: 'event', event: makeEvent(d, 2, 1, d.intermediateAnchor) });
    }
  }

  if (d.phase === 'DRIVING') {
    const l = limits(d);
    const shiftSec = d.shiftStartAt !== null ? (at - d.shiftStartAt) / 1000 : 0;
    if (shiftSec >= l.maxShiftSec || d.driveSecShift >= l.maxDriveSec) {
      d.phase = 'STOPPING';
      d.stopKind = 'END';
    } else if (d.driveSecSinceStop >= d.nextStopAfterSec) {
      d.phase = 'STOPPING';
      d.stopKind = d.nextStop;
    }
  } else if (d.phase === 'STOPPING' && d.speedMph === 0) {
    emitPoint(d, at, true, out);
    d.phase = 'STOPPED_D';
    d.phaseUntil = at + AUTO_ON_AFTER_MS;
  }
  void opts;
}

function maybePoint(d: DriverSim, opts: EngineOptions, out: SimAction[]): void {
  const every = (d.engineOn ? opts.pointEverySec : opts.idlePointEverySec) * 1000;
  if (d.lastPointAt === null || d.simAt - d.lastPointAt >= every) emitPoint(d, d.simAt, false, out);
}

/**
 * Advances the driver from `d.simAt` to `now` (wall clock). Returns everything the app would
 * have sent for that span, in chronological order.
 */
export function step(d: DriverSim, now: number, opts: EngineOptions = DEFAULT_ENGINE_OPTIONS): SimAction[] {
  const out: SimAction[] = [];
  let guard = 0;
  while (d.simAt < now && guard++ < 1_000_000) {
    let next = Math.min(now, d.simAt + SUBSTEP_MS);
    if (d.phaseUntil !== null && d.phaseUntil > d.simAt && d.phaseUntil < next) next = d.phaseUntil;
    const dtSec = (next - d.simAt) / 1000;
    integrate(d, dtSec, next, opts, out);
    d.simAt = next;
    if (d.phaseUntil !== null && d.simAt >= d.phaseUntil) onTimer(d, opts, out);
    maybePoint(d, opts, out);
  }
  return out;
}

/**
 * Graceful stop: the truck pulls over and the driver goes OFF DUTY now (a live status change
 * ending an open D is accepted, decisions.md D-089), engine shut down.
 */
export function goOffDuty(d: DriverSim, now: number): SimAction[] {
  const out: SimAction[] = [];
  d.simAt = Math.max(d.simAt, now);
  if (d.speedMph > 0) {
    d.speedMph = 0;
    emitPoint(d, now, true, out);
  }
  if (d.engineOn) {
    endShift(d, now, out);
  } else if (d.duty !== 'OFF') {
    out.push(duty(d, 'OFF', now));
  }
  d.phase = 'REST';
  d.stopKind = null;
  d.intermediateAnchor = null;
  d.phaseUntil = now + limits(d).restSec;
  return out;
}

/** Restart after a long gap (> the 10-min drift window): resume from here, no replay. */
export function resumeAfterGap(d: DriverSim, now: number): void {
  d.simAt = now;
  if (d.phaseUntil !== null && d.phaseUntil < now) d.phaseUntil = now + 1000;
  d.lastPointAt = null;
}
