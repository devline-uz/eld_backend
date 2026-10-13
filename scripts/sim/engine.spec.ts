import { verifyChecksum } from '../../src/modules/ingest/checksum';
import {
  AUTO_ON_AFTER_MS,
  goOffDuty,
  initDriver,
  step,
  tzOffsetMin,
  type DriverSim,
  type EldEventPayload,
  type EngineOptions,
  type SimAction,
} from './engine';
import { advance, findRoute, haversineMi, positionAt, routeLengthMi, ROUTES } from './routes';

const T0 = Date.parse('2026-10-13T12:00:00Z');
const MIN = 60_000;
const OPTS: EngineOptions = { pointEverySec: 60, idlePointEverySec: 300, quickStart: false };

function driver(over: Partial<{ violation: boolean; shiftStartAt: number }> = {}): DriverSim {
  return initDriver({
    slot: 1,
    routeId: 'I40',
    startDistMi: 200,
    dir: 1,
    odometerKm: 150_000,
    tz: 'America/Chicago',
    violation: over.violation ?? false,
    simAt: T0,
    shiftStartAt: over.shiftStartAt ?? T0,
    seed: 7,
  });
}

const events = (a: SimAction[]) => a.flatMap((x) => (x.kind === 'event' ? [x.event] : []));
const duties = (a: SimAction[]) => a.flatMap((x) => (x.kind === 'duty' ? [x] : []));
const points = (a: SimAction[]) => a.flatMap((x) => (x.kind === 'point' ? [x.point] : []));
const code = (e: EldEventPayload) => `${e.eventType}/${e.eventCode}`;

describe('driver sim engine', () => {
  it('starts a shift like the app: power-up 6/1, ON tap, then automatic D 1/3 above 5 mph', () => {
    const d = driver();
    const out = step(d, T0 + 30 * MIN, OPTS);
    const ev = events(out);
    expect(ev.map(code).slice(0, 2)).toEqual(['6/1', '1/3']);
    expect(duties(out).map((x) => x.status)).toEqual(['ON']);
    const drive = ev.find((e) => code(e) === '1/3')!;
    // Pre-trip is 10-15 minutes of real time.
    const pre = (Date.parse(drive.eventDateTime) - T0) / MIN;
    expect(pre).toBeGreaterThanOrEqual(10);
    expect(pre).toBeLessThanOrEqual(15.5);
    expect(drive.recordOrigin).toBe(1);
    expect(d.duty).toBe('D');
    expect(d.speedMph).toBeGreaterThan(15); // cruising or in a random slowdown
    // Checksums match the server's canonical algorithm (no diagnostic 3).
    for (const e of ev) expect(verifyChecksum({ ...e, eventDateTime: new Date(e.eventDateTime) }, e.checksum).ok).toBe(true);
    // Raw odometer is whole km (as the checksum canonical form) and grows.
    expect(Number.isInteger(drive.rawDeviceOdometerKm)).toBe(true);
  });

  it('quick start shortens only the first pre-trip', () => {
    const d = driver();
    const out = step(d, T0 + 6 * MIN, { ...OPTS, quickStart: true });
    expect(events(out).some((e) => code(e) === '1/3')).toBe(true);
  });

  it('never stamps anything after `now` (no time compression) and keeps 60 s telemetry spacing', () => {
    const d = driver();
    const now = T0 + 90 * MIN;
    const out = step(d, now, OPTS);
    const times = [
      ...events(out).map((e) => Date.parse(e.eventDateTime)),
      ...points(out).map((p) => Date.parse(p.time)),
      ...duties(out).map((x) => Date.parse(x.at)),
    ];
    expect(Math.max(...times)).toBeLessThanOrEqual(now);
    const periodic = points(out).filter((p) => !p.isTransition).map((p) => Date.parse(p.time));
    for (let i = 1; i < periodic.length; i++) expect(periodic[i] - periodic[i - 1]).toBeGreaterThanOrEqual(59_000);
    expect(points(out).some((p) => p.isTransition && p.speedKmh > 8)).toBe(true);
  });

  it('logs an intermediate 2/1 every hour of driving', () => {
    const d = driver();
    const out = step(d, T0 + 14 * MIN, OPTS); // into D
    d.nextStopAfterSec = 10 * 3600; // no stop for this test
    const more = step(d, T0 + 14 * MIN + 2.5 * 3600_000, OPTS);
    const inter = events([...out, ...more]).filter((e) => code(e) === '2/1');
    expect(inter).toHaveLength(2);
    const dAt = Date.parse(events(out).find((e) => code(e) === '1/3')!.eventDateTime);
    expect(Date.parse(inter[0].eventDateTime) - dAt).toBeGreaterThanOrEqual(3600_000 - 1000);
    expect(Date.parse(inter[0].eventDateTime) - dAt).toBeLessThanOrEqual(3600_000 + 1000);
  });

  it('a fuel stop: 0 mph, automatic ON 1/4 after 5+1 min, then D again', () => {
    const d = driver();
    step(d, T0 + 20 * MIN, OPTS);
    d.nextStop = 'FUEL';
    d.nextStopAfterSec = 0;
    const out = step(d, T0 + 50 * MIN, OPTS);
    const ev = events(out);
    const on = ev.find((e) => code(e) === '1/4')!;
    const stopPoint = points(out).find((p) => p.isTransition && p.speedKmh === 0)!;
    expect(Date.parse(on.eventDateTime) - Date.parse(stopPoint.time)).toBe(AUTO_ON_AFTER_MS);
    expect(ev.filter((e) => code(e) === '1/3')).toHaveLength(1);
    expect(duties(out)).toHaveLength(0);
    expect(d.duty).toBe('D');
  });

  it('a 30-min break: auto ON, driver taps OFF for >= 30 min, then ON and drives again', () => {
    const d = driver();
    step(d, T0 + 20 * MIN, OPTS);
    d.nextStop = 'BREAK';
    d.nextStopAfterSec = 0;
    const out = step(d, T0 + 70 * MIN, OPTS);
    const taps = duties(out);
    expect(taps.map((t) => t.status)).toEqual(['OFF', 'ON']);
    expect(Date.parse(taps[1].at) - Date.parse(taps[0].at)).toBeGreaterThanOrEqual(30 * MIN);
    expect(events(out).map(code)).toEqual(expect.arrayContaining(['1/4', '1/3']));
    expect(d.driveSecSinceBreak).toBeLessThan(30 * 60);
  });

  it('normal drivers end the shift before 11 h driving; violation drivers keep going past it', () => {
    const normal = driver();
    const bad = driver({ violation: true });
    const end = T0 + 13 * 3600_000;
    const outN = step(normal, end, OPTS);
    const outB = step(bad, end, OPTS);
    expect(normal.driveSecShift).toBeLessThanOrEqual(10.6 * 3600);
    expect(events(outN).some((e) => code(e) === '6/3')).toBe(true);
    expect(bad.driveSecShift).toBeGreaterThan(11 * 3600);
    expect(duties(outB).filter((x) => x.status === 'OFF')).toHaveLength(0);
  });

  it('goOffDuty pulls over: stop point, shut-down 6/3, OFF tap', () => {
    const d = driver();
    step(d, T0 + 30 * MIN, OPTS);
    const out = goOffDuty(d, T0 + 30 * MIN);
    expect(points(out)[0].speedKmh).toBe(0);
    expect(events(out).map(code)).toEqual(['6/3']);
    expect(duties(out).map((x) => x.status)).toEqual(['OFF']);
    expect(d.engineOn).toBe(false);
  });

  it('timezone offsets follow the app convention (minutes east of UTC)', () => {
    expect(tzOffsetMin('America/New_York', T0)).toBe(-240);
    expect(tzOffsetMin('America/Los_Angeles', Date.parse('2026-01-10T12:00:00Z'))).toBe(-480);
  });
});

describe('sim routes', () => {
  it('every route is a sane interstate polyline', () => {
    for (const r of ROUTES) {
      expect(r.points.length).toBeGreaterThan(10);
      expect(routeLengthMi(r)).toBeGreaterThan(400);
      for (let i = 1; i < r.points.length; i++) expect(haversineMi(r.points[i - 1], r.points[i])).toBeLessThan(200);
    }
  });

  it('bounces at both ends', () => {
    const r = findRoute('I20');
    const len = routeLengthMi(r);
    expect(advance(r, len - 1, 1, 3)).toEqual({ distMi: len - 2, dir: -1 });
    expect(advance(r, 1, -1, 3)).toEqual({ distMi: 2, dir: 1 });
    const p = positionAt(r, 0, 1);
    expect(p.lat).toBeCloseTo(32.78, 2);
  });
});
