import { createRng } from '../context';
import {
  buildDrivingSegments,
  coarsen1Mi,
  DAY_MS,
  HOUR_MS,
  MIN_MS,
  newVehicleState,
  OLD_INTERVAL_MS,
  planCodes,
  planDtcs,
  RECENT_INTERVAL_MS,
  sampleIntervalMs,
  segmentTelemetry,
  type SourceEvent,
  valueAt,
} from './ingest.helpers';

const TO = Date.UTC(2026, 8, 14, 15, 0, 0);
const ev = (p: Partial<SourceEvent> & { eventType: number; eventCode: number; at: number }): SourceEvent => ({
  driverId: 'd1',
  vehicleId: 'v1',
  timezoneOffset: -5,
  lat: null,
  lon: null,
  miles: null,
  engineHours: null,
  ...p,
});

describe('ingest mock helpers', () => {
  it('uses the dense cadence only inside the last 14 days', () => {
    expect(sampleIntervalMs(TO - 2 * DAY_MS, TO)).toBe(RECENT_INTERVAL_MS);
    expect(sampleIntervalMs(TO - 40 * DAY_MS, TO)).toBe(OLD_INTERVAL_MS);
  });

  it('splits D -> intermediate -> OFF into one closed segment with waypoints', () => {
    const t0 = TO - 10 * HOUR_MS;
    const segs = buildDrivingSegments(
      [
        ev({ eventType: 1, eventCode: 3, at: t0, lat: 41.88, lon: -87.63, miles: 100000 }),
        ev({ eventType: 2, eventCode: 1, at: t0 + HOUR_MS, lat: 41.6, lon: -86.7, miles: 100058 }),
        ev({ eventType: 1, eventCode: 4, at: t0 + 2 * HOUR_MS, lat: 41.5, lon: -85.8, miles: 100110 }),
        ev({ eventType: 1, eventCode: 3, at: t0 + 3 * HOUR_MS, lat: 41.5, lon: -85.8, miles: 100110 }),
      ],
      TO,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ open: false, nextDutyCode: 4, end: t0 + 2 * HOUR_MS, restUntil: t0 + 3 * HOUR_MS });
    expect(segs[0].waypoints).toHaveLength(3);
    expect(segs[1]).toMatchObject({ open: true, end: TO });
  });

  it('drops segments without any located record and ignores events after `to`', () => {
    const segs = buildDrivingSegments(
      [ev({ eventType: 1, eventCode: 3, at: TO - HOUR_MS }), ev({ eventType: 1, eventCode: 1, at: TO + HOUR_MS, lat: 40, lon: -90 })],
      TO,
    );
    expect(segs).toHaveLength(0);
  });

  it('produces coarsened, monotonic, never-future telemetry consistent with the odometer', () => {
    const rng = createRng(7);
    const t0 = TO - 6 * HOUR_MS;
    const [seg] = buildDrivingSegments(
      [
        ev({ eventType: 1, eventCode: 3, at: t0, lat: 41.88, lon: -87.63, miles: 100000, engineHours: 9000 }),
        ev({ eventType: 1, eventCode: 4, at: t0 + 2 * HOUR_MS, lat: 41.5, lon: -85.8, miles: 100120 }),
      ],
      TO,
    );
    const state = newVehicleState('v1', rng, { odometer: 99990, engineHours: 9000, busType: null });
    const rows = segmentTelemetry(seg, state, rng, { to: TO });
    expect(rows.length).toBeGreaterThan(20);
    let prevOdo = 0;
    for (const r of rows) {
      expect(r.time.getTime()).toBeLessThanOrEqual(TO);
      // latitude sits on the 1-mile grid (1/69 deg); longitude's step depends on latitude
      expect(Math.abs(r.latitude * 69 - Math.round(r.latitude * 69))).toBeLessThan(1e-3);
      expect(coarsen1Mi({ lat: r.latitude, lon: r.longitude }).lat).toBeCloseTo(r.latitude, 5);
      expect(r.odometerMi).toBeGreaterThanOrEqual(prevOdo);
      prevOdo = r.odometerMi;
    }
    const driving = rows.filter((r) => r.speedMph > 5);
    expect(driving.length).toBeGreaterThan(15);
    // 120 recorded miles in 2 h -> ~60 mph average
    const avg = driving.reduce((s, r) => s + r.speedMph, 0) / driving.length;
    expect(avg).toBeGreaterThan(45);
    expect(avg).toBeLessThan(75);
    expect(state.odometer).toBe(100120);
    // ON after the stop -> idle fixes: engine on at 0 mph
    const idle = rows.filter((r) => r.time.getTime() > t0 + 2 * HOUR_MS);
    expect(idle.length).toBeGreaterThan(0);
    expect(idle.every((r) => r.engineOn && r.speedMph === 0)).toBe(true);
    // (time, vehicleId) primary key never repeats
    expect(new Set(rows.map((r) => r.time.getTime())).size).toBe(rows.length);
  });

  it('gives old segments sparse ticks and a stop fix only (no pre-trip or rest fixes)', () => {
    const t0 = TO - 40 * DAY_MS;
    const [seg] = buildDrivingSegments(
      [
        ev({ eventType: 1, eventCode: 3, at: t0, lat: 41.88, lon: -87.63, miles: 100000 }),
        ev({ eventType: 1, eventCode: 4, at: t0 + 3 * HOUR_MS, lat: 41.5, lon: -84.9, miles: 100170 }),
        ev({ eventType: 1, eventCode: 3, at: t0 + 5 * HOUR_MS, lat: 41.5, lon: -84.9, miles: 100170 }),
      ],
      TO,
    );
    const rows = segmentTelemetry(seg, newVehicleState('v1', createRng(5), { odometer: 100000, engineHours: 1, busType: null }), createRng(6), { to: TO });
    expect(rows.every((r) => r.time.getTime() >= t0 && r.time.getTime() <= t0 + 3 * HOUR_MS)).toBe(true);
    expect(rows).toHaveLength(4); // ticks at 0 h, 1 h, 2 h + stop fix at 3 h
    expect(rows[rows.length - 1]).toMatchObject({ speedMph: 0, engineOn: true, odometerMi: 100170 });
  });

  it('keeps an open segment moving up to now, or goes silent when stale', () => {
    const t0 = TO - 50 * MIN_MS;
    const events = [ev({ eventType: 1, eventCode: 3, at: t0, lat: 35.1, lon: -106.6, miles: 5000 })];
    const [seg] = buildDrivingSegments(events, TO);
    const live = segmentTelemetry(seg, newVehicleState('v1', createRng(1), { odometer: 5000, engineHours: 1, busType: 'J1939' }), createRng(2), { to: TO });
    const last = live[live.length - 1];
    expect(TO - last.time.getTime()).toBeLessThan(2 * MIN_MS);
    expect(last.speedMph).toBeGreaterThan(40);
    const [seg2] = buildDrivingSegments(events, TO);
    const stale = segmentTelemetry(seg2, newVehicleState('v1', createRng(1), { odometer: 5000, engineHours: 1, busType: 'J1939' }), createRng(2), { to: TO, staleCutMs: 45 * MIN_MS });
    expect(TO - stale[stale.length - 1].time.getTime()).toBeGreaterThan(30 * MIN_MS);
  });

  it('never writes a fix backwards in time, so overlapping segments on one truck stay monotonic', () => {
    const t0 = TO - 5 * HOUR_MS;
    const a = buildDrivingSegments(
      [ev({ eventType: 1, eventCode: 3, at: t0, lat: 40, lon: -90, miles: 1000 }), ev({ eventType: 1, eventCode: 1, at: t0 + 2 * HOUR_MS, lat: 40.5, lon: -88.5, miles: 1110 })],
      TO,
    )[0];
    // a second driver's segment that starts inside the first one, on another mileage base
    const b = buildDrivingSegments(
      [ev({ driverId: 'd2', eventType: 1, eventCode: 3, at: t0 + HOUR_MS, lat: 41, lon: -87, miles: 900 }), ev({ driverId: 'd2', eventType: 1, eventCode: 1, at: t0 + 3 * HOUR_MS, lat: 41.4, lon: -86, miles: 1000 })],
      TO,
    )[0];
    const state = newVehicleState('v1', createRng(9), { odometer: 1000, engineHours: 100, busType: null });
    const rows = [...segmentTelemetry(a, state, createRng(1), { to: TO }), ...segmentTelemetry(b, state, createRng(2), { to: TO })];
    // the second driver's segment must not be re-based onto the first one's counter
    expect(Math.max(...rows.map((r) => r.odometerMi))).toBeLessThanOrEqual(1110);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].time.getTime()).toBeGreaterThan(rows[i - 1].time.getTime());
      expect(rows[i].odometerMi).toBeGreaterThanOrEqual(rows[i - 1].odometerMi);
      expect(rows[i].engineHours).toBeGreaterThanOrEqual(rows[i - 1].engineHours);
    }
  });

  it('interpolates type-7 odometer / engine hours inside the surrounding records, rounded down', () => {
    const pts = [
      { at: 0, value: 100 },
      { at: 10, value: 150 },
      { at: 20, value: 150 },
      { at: 30, value: 210 },
    ];
    expect(valueAt([], 5, 0)).toBeNull();
    expect(valueAt(pts, -5, 0)).toBe(100);
    expect(valueAt(pts, 99, 0)).toBe(210);
    expect(valueAt(pts, 5, 0)).toBe(125);
    expect(valueAt(pts, 15, 0)).toBe(150);
    expect(valueAt(pts, 29, 0)).toBe(204);
    expect(valueAt([{ at: 0, value: 8885.71 }, { at: 3, value: 8887.01 }], 1, 2)).toBe(8886.14);
    for (let t = -3; t <= 33; t += 1) {
      const v = valueAt(pts, t, 0)!;
      const prev = [...pts].reverse().find((p) => p.at <= t);
      const next = pts.find((p) => p.at >= t);
      if (prev) expect(v).toBeGreaterThanOrEqual(prev.value);
      if (next) expect(v).toBeLessThanOrEqual(next.value);
    }
  });

  it('plans codes with clears never in the future', () => {
    const rng = createRng(3);
    const seg = buildDrivingSegments(
      [ev({ eventType: 1, eventCode: 3, at: TO - 3 * HOUR_MS, lat: 40, lon: -90 }), ev({ eventType: 1, eventCode: 1, at: TO - HOUR_MS, lat: 40.5, lon: -89 })],
      TO,
    )[0];
    let n = 0;
    for (let i = 0; i < 3000; i += 1) {
      for (const p of planCodes(seg, rng, TO)) {
        n += 1;
        expect(p.loggedAt).toBeGreaterThanOrEqual(seg.start);
        expect(p.loggedAt).toBeLessThanOrEqual(seg.end);
        if (p.clearedAt !== null) {
          expect(p.clearedAt).toBeGreaterThan(p.loggedAt);
          expect(p.clearedAt).toBeLessThanOrEqual(TO);
        }
        expect(p.code).toMatch(p.kind === 'malfunction' ? /^[PETLRS]$/ : /^[1-6]$/);
      }
    }
    expect(n).toBeGreaterThan(30);
  });

  it('plans DTCs with one open row per (spn, fmi) and no future timestamps', () => {
    const rng = createRng(11);
    const all = [];
    for (let i = 0; i < 200; i += 1) all.push(...planDtcs(`v${i}`, rng, TO - 184 * DAY_MS, TO));
    expect(all.some((r) => r.clearedAt === null)).toBe(true);
    expect(all.some((r) => r.clearedAt !== null)).toBe(true);
    const open = new Set<string>();
    for (const r of all) {
      expect(r.lastSeenAt.getTime()).toBeLessThanOrEqual(TO);
      expect(r.firstSeenAt.getTime()).toBeLessThanOrEqual(r.lastSeenAt.getTime());
      if (r.clearedAt) {
        expect(r.clearedAt.getTime()).toBeLessThanOrEqual(TO);
        expect(r.clearedAt.getTime()).toBeGreaterThanOrEqual(r.lastSeenAt.getTime());
      } else {
        const key = `${r.vehicleId}:${r.spn}:${r.fmi}`;
        expect(open.has(key)).toBe(false);
        open.add(key);
      }
      expect(r.description).toMatch(/^(Critical|Warning|Info): /);
    }
  });
});
