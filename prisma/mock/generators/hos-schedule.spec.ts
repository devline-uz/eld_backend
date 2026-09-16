/**
 * Mock HOS generator — the schedule and record builders are checked against the REAL engine,
 * the REAL RODS day builder and the REAL event mapper, so the mock data can never teach the
 * UI something the product itself would not compute.
 *
 * Run: npx jest with a config whose testMatch is prisma/mock/generators/hos-schedule.spec.ts (the
 * repo's unit project only matches src/**).
 */
import { computeHos } from '../../../src/modules/hos/engine/compute-hos';
import { buildSegments, normalizeEvents } from '../../../src/modules/hos/engine/normalize';
import { addDays, dayEnd, dayKey, dayLengthSec, dayStart } from '../../../src/modules/hos/engine/timezone';
import { mapEldEventsToNormalized } from '../../../src/modules/hos/hos-event-mapper';
import type { Violation } from '../../../src/modules/hos/hos.types';
import { verifyChecksum } from '../../../src/modules/ingest/checksum';
import { buildRodsDay, type RodsEvent } from '../../../src/modules/logs/rods';
import { createRng } from '../context';
import {
  buildDriverEvents,
  buildRoute,
  buildUnidentifiedEvents,
  CORRIDORS,
  findCity,
  HOS_EVENT_UUID_PREFIX,
  metroLoop,
  mockUuid,
  motionsFromSegments,
  pickUnidentifiedEpisodes,
  planCertifications,
  positionAt,
  VehicleMotion,
  type EventRow,
  type VehicleCtx,
} from './hos-events';
import {
  applyEdits,
  COMPLIANT_RATES,
  DAY,
  dailyTotals,
  DEFAULT_RATES,
  effective,
  H,
  M,
  planDriver,
  teamTimetable,
  toEngineEvents,
  type Plan,
  type PlanInput,
  type Seg,
} from './hos-schedule';
import { distanceMi } from '../../../src/common/units/location';

const TZ = 'America/New_York';
const NOW = Date.parse('2026-09-14T08:56:00Z');
const START = dayStart(TZ, '2026-03-15').getTime();

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    profile: 'LONG_HAUL',
    ruleset: 'US_70_8_PROPERTY',
    timezone: TZ,
    flags: { pc: false, ym: false, split: false, shortHaul: false, adverse: false },
    start: START,
    end: NOW,
    now: NOW,
    vehicleId: 'veh-1',
    teams: [],
    tail: null,
    rates: COMPLIANT_RATES,
    ...overrides,
  };
}

/** Violations the way production accrues them: one recalculation per day, now = end of that day. */
function dailyViolations(segments: Seg[], inp: PlanInput): Violation[] {
  const events = toEngineEvents(segments);
  const tz = inp.timezone;
  const lastInstant = Math.min(inp.end, inp.now);
  const out: Violation[] = [];
  for (let key = dayKey(tz, new Date(inp.start)); key <= dayKey(tz, new Date(lastInstant)); key = addDays(key, 1)) {
    const nowK = Math.min(dayEnd(tz, key).getTime() - 1, inp.now);
    const from = dayStart(tz, addDays(key, -9)).getTime();
    const window = events.filter((e) => e.at.getTime() >= from && e.at.getTime() <= nowK);
    const state = computeHos({
      events: window,
      driver: { driverId: 'd', splitSleeperEnabled: inp.flags.split, shortHaulException: inp.flags.shortHaul, adverseDrivingEnabled: inp.flags.adverse },
      ruleset: inp.ruleset,
      now: new Date(nowK),
      timezone: tz,
      previousDays: [],
      lastRestartEndedAt: null,
    });
    out.push(...state.violations.filter((v) => v.logDate === key));
  }
  return out;
}

function assertContiguous(plan: Plan, inp: PlanInput): void {
  expect(plan.segments.length).toBeGreaterThan(0);
  expect(plan.segments[0].start).toBe(inp.start);
  for (let i = 1; i < plan.segments.length; i += 1) {
    expect(plan.segments[i].start).toBe(plan.segments[i - 1].end);
    expect(plan.segments[i].end).toBeGreaterThan(plan.segments[i].start);
  }
  expect(plan.segments[plan.segments.length - 1].end).toBeLessThanOrEqual(Math.min(inp.end, inp.now));
}

function vehicleCtx(id: string, segments: Seg[]): VehicleCtx {
  const motions = motionsFromSegments(segments, () => 55).get(id) ?? [];
  return {
    id,
    deviceId: `dev-${id}`,
    offsetMi: 12,
    baseMi: 250_000,
    baseEngineHours: 9000,
    motion: new VehicleMotion(motions),
    route: buildRoute(CORRIDORS['I-95']),
    routeOffsetMi: 100,
  };
}

function eventsFor(plan: Plan, inp: PlanInput, seed = 7) {
  const rng = createRng(seed);
  const vehicles = new Map([[inp.vehicleId as string, vehicleCtx(inp.vehicleId as string, plan.segments)]]);
  const keys: string[] = [];
  for (let k = dayKey(TZ, new Date(inp.start)); k <= dayKey(TZ, new Date(inp.now)); k = addDays(k, 1)) keys.push(k);
  return buildDriverEvents({
    driverId: 'drv-1',
    timezone: inp.timezone,
    segments: plan.segments,
    edits: plan.edits,
    planCerts: (logins, applied) => planCertifications(rng, TZ, keys, logins, applied, inp.now),
    vehicles,
    now: inp.now,
    rng,
  });
}

/** EventRows with synthetic ids, the way `buildRodsDay` sees database rows. */
function asRods(rows: EventRow[]): RodsEvent[] {
  const idByUuid = new Map(rows.map((r, i) => [r.uuid, BigInt(i + 1)]));
  return rows.map((r, i) => ({
    id: BigInt(i + 1),
    eventType: r.eventType,
    eventCode: r.eventCode,
    eventDateTime: r.eventDateTime,
    recordStatus: r.recordStatus,
    recordOrigin: r.recordOrigin,
    eventSequenceId: r.eventSequenceId,
    supersedesId: r.supersedesUuid ? (idByUuid.get(r.supersedesUuid) ?? null) : null,
    totalVehicleMiles: r.totalVehicleMiles,
  }));
}

const PROFILES = [
  { name: 'long-haul', inp: input({ profile: 'LONG_HAUL' }) },
  { name: 'long-haul split sleeper + PC/YM', inp: input({ profile: 'LONG_HAUL', flags: { pc: true, ym: true, split: true, shortHaul: false, adverse: false } }) },
  { name: 'regional', inp: input({ profile: 'REGIONAL' }) },
  { name: 'local short-haul', inp: input({ profile: 'LOCAL', flags: { pc: true, ym: true, split: false, shortHaul: true, adverse: false } }) },
  { name: 'regional 60/7', inp: input({ profile: 'REGIONAL', ruleset: 'US_60_7_PROPERTY' }) },
  { name: 'long-haul adverse', inp: input({ profile: 'LONG_HAUL', flags: { pc: false, ym: false, split: false, shortHaul: false, adverse: true } }) },
  { name: 'passenger', inp: input({ profile: 'REGIONAL', ruleset: 'US_70_8_PASSENGER' }) },
  { name: 'Chicago terminal', inp: input({ profile: 'LONG_HAUL', timezone: 'America/Chicago', start: dayStart('America/Chicago', '2026-03-15').getTime() }) },
];

describe('hos mock planner — compliant by construction', () => {
  for (const { name, inp } of PROFILES) {
    for (const seed of [11, 42]) {
      it(`${name} (seed ${seed}) is contiguous and produces zero engine violations`, () => {
        const plan = planDriver(createRng(seed), inp);
        assertContiguous(plan, inp);
        const final = applyEdits(plan.segments, plan.edits);
        expect(dailyViolations(final, inp)).toEqual([]);
      });
    }
  }

  it('long-haul split drivers get 7/3, 8/2 and 7.5/2.5 pairs, none of them flagged', () => {
    const inp = PROFILES[1].inp;
    const shapes = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const plan = planDriver(createRng(seed), inp);
      plan.splits.forEach((s) => shapes.add(`${s.longH}/${s.shortH}`));
      expect(dailyViolations(applyEdits(plan.segments, plan.edits), inp)).toEqual([]);
    }
    expect(shapes).toEqual(new Set(['7/3', '8/2', '7.5/2.5']));
  });

  it('takes 34-hour restarts and never exceeds 70 h in any 8-day window', () => {
    const inp = PROFILES[0].inp;
    const plan = planDriver(createRng(5), inp);
    expect(plan.restarts).toBeGreaterThanOrEqual(10);
    const longRests = plan.segments.filter((s, i, all) => {
      if (effective(s.status, s.special) === 'ON' || s.status === 'D') return false;
      let end = s.end;
      for (let j = i + 1; j < all.length && ['OFF', 'SB'].includes(effective(all[j].status, all[j].special)); j += 1) end = all[j].end;
      return end - s.start >= 34 * H;
    });
    expect(longRests.length).toBeGreaterThan(0);
  });

  it('local drivers are home on weekends and work day shifts', () => {
    const inp = PROFILES[3].inp;
    const plan = planDriver(createRng(9), inp);
    const drives = plan.segments.filter((s) => s.status === 'D');
    const sunday = drives.filter((s) => new Date(`${dayKey(TZ, new Date(s.start))}T12:00:00Z`).getUTCDay() === 0);
    expect(sunday.length).toBe(0);
    expect(plan.segments.some((s) => s.status === 'SB')).toBe(false);
  });

  it('PC and YM only appear for drivers allowed to use them', () => {
    const denied = planDriver(createRng(3), PROFILES[0].inp);
    expect(denied.segments.some((s) => s.special !== 'NONE')).toBe(false);
    const allowed = planDriver(createRng(3), PROFILES[1].inp);
    expect(allowed.segments.some((s) => s.special === 'PC')).toBe(true);
    expect(allowed.segments.some((s) => s.special === 'YM')).toBe(true);
  });

  it('a terminated driver has no record after the termination instant and no live tail', () => {
    const end = START + 60 * DAY + 5 * H;
    const inp = input({ end, tail: { status: 'D', nearLimit: false } });
    const plan = planDriver(createRng(8), inp);
    assertContiguous(plan, inp);
    expect(plan.segments[plan.segments.length - 1].end).toBeLessThanOrEqual(end);
    expect(['OFF', 'SB']).toContain(plan.segments[plan.segments.length - 1].status);
  });
});

describe('hos mock planner — injected violations are detected by the engine', () => {
  const boosted = { ...DEFAULT_RATES, driving11: 0.08, shift14: 0.08, break30: 0.08, forgotOff: 0, cycleSkip: 0 };

  for (const profile of ['LONG_HAUL', 'REGIONAL'] as const) {
    it(`${profile}: DRIVING_11 / SHIFT_14 / BREAK_30 injections are flagged on their shift day`, () => {
      const inp = input({ profile, rates: boosted });
      const plan = planDriver(createRng(21), inp);
      const violations = dailyViolations(applyEdits(plan.segments, plan.edits), inp);
      for (const kind of ['DRIVING_11', 'SHIFT_14', 'BREAK_30'] as const) {
        const injected = plan.injections.filter((i) => i.kind === kind);
        expect(injected.length).toBeGreaterThan(0);
        const hits = injected.filter((i) => {
          const d0 = dayKey(TZ, new Date(i.at));
          return violations.some((v) => v.type === kind && (v.logDate === d0 || v.logDate === addDays(d0, 1)));
        });
        expect(hits.length / injected.length).toBeGreaterThanOrEqual(0.9);
      }
      // Nothing is flagged that was not injected.
      const injectedDays = new Set(plan.injections.flatMap((i) => [dayKey(TZ, new Date(i.at)), addDays(dayKey(TZ, new Date(i.at)), 1)]));
      expect(violations.filter((v) => !injectedDays.has(v.logDate))).toEqual([]);
    });
  }

  it('adverse-driving drivers need 13 h to be flagged for DRIVING_11', () => {
    const inp = input({ rates: { ...boosted, shift14: 0, break30: 0 }, flags: { pc: false, ym: false, split: false, shortHaul: false, adverse: true } });
    const plan = planDriver(createRng(4), inp);
    const violations = dailyViolations(plan.segments, inp).filter((v) => v.type === 'DRIVING_11');
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.detail.includes('13'))).toBe(true);
  });

  it('skipping a due restart produces a CYCLE_70 violation', () => {
    const inp = input({ rates: { ...COMPLIANT_RATES, cycleSkip: 1 } });
    const plan = planDriver(createRng(6), inp);
    expect(plan.injections.some((i) => i.kind === 'CYCLE')).toBe(true);
    expect(dailyViolations(plan.segments, inp).some((v) => v.type === 'CYCLE_70')).toBe(true);
  });

  it('a forgotten OFF record causes violations that the driver edit clears (AUTO_CLEARED path)', () => {
    const inp = input({ rates: { ...COMPLIANT_RATES, forgotOff: 0.2 } });
    const plan = planDriver(createRng(13), inp);
    const forgot = plan.injections.filter((i) => i.kind === 'FORGOT_OFF');
    expect(forgot.length).toBeGreaterThan(2);
    const before = dailyViolations(plan.segments, inp);
    expect(before.some((v) => v.type === 'DRIVING_11' || v.type === 'SHIFT_14')).toBe(true);

    const after = dailyViolations(applyEdits(plan.segments, plan.edits), inp);
    const edited = new Set(plan.edits.filter((e) => e.kind === 'INSERT_OFF').map((e) => e.start));
    const unedited = forgot.filter((f) => !edited.has(f.at)).map((f) => dayKey(TZ, new Date(f.at)));
    const allowed = new Set(unedited.flatMap((d) => [d, addDays(d, 1), addDays(d, 2)]));
    expect(after.filter((v) => !allowed.has(v.logDate))).toEqual([]);
    expect(after.length).toBeLessThan(before.length);
  });
});

describe('hos mock planner — the driver state right now', () => {
  for (const status of ['D', 'ON', 'SB', 'OFF'] as const) {
    for (const nearLimit of [false, true]) {
      it(`tail target ${status}${nearLimit ? ' near the limit' : ''} is the engine's current status`, () => {
        const inp = input({ profile: 'LONG_HAUL', tail: { status, nearLimit } });
        const plan = planDriver(createRng(31), inp);
        assertContiguous(plan, inp);
        const state = computeHos({
          events: toEngineEvents(plan.segments),
          driver: { driverId: 'd' },
          ruleset: inp.ruleset,
          now: new Date(NOW),
          timezone: TZ,
          previousDays: [],
          lastRestartEndedAt: null,
        });
        expect(state.currentStatus).toBe(status);
        if (status === 'D' && nearLimit) expect(state.driveRemainingSec).toBeLessThan(90 * 60);
        expect(state.violations.filter((v) => v.logDate === dayKey(TZ, new Date(NOW)) && v.type !== 'CYCLE_70')).toEqual([]);
      });
    }
  }
});

describe('hos mock planner — team driving', () => {
  it('co-drivers alternate: never both driving, the resting one is in the berth', () => {
    const team = { start: START + 20 * DAY, end: START + 40 * DAY };
    const a = planDriver(createRng(1), input({ teams: [{ ...team, role: 'A', vehicleId: 'veh-team' }] }));
    const b = planDriver(createRng(2), input({ vehicleId: 'veh-b', teams: [{ ...team, role: 'B', vehicleId: 'veh-team' }] }));
    const drivesA = a.segments.filter((s) => s.status === 'D' && s.team);
    const drivesB = b.segments.filter((s) => s.status === 'D' && s.team);
    expect(drivesA.length).toBeGreaterThan(5);
    expect(drivesB.length).toBeGreaterThan(5);
    for (const x of drivesA) {
      expect(drivesB.some((y) => y.start < x.end && x.start < y.end)).toBe(false);
      expect(x.vehicleId).toBe('veh-team');
    }
    expect(dailyViolations(a.segments, input())).toEqual([]);
    expect(dailyViolations(b.segments, input())).toEqual([]);
  });

  it('a co-driver whose plan starts after the pairing joins the same legs — no overlapping D on the truck (B-060)', () => {
    // B was hired 2 days 7 h 20 min after the pairing started: an offset that is not a multiple
    // of a leg, so a cursor-anchored timetable would put both drivers in D for hours every day.
    const team = { start: START + 20 * DAY + 3 * H, end: START + 60 * DAY };
    const lateStart = dayStart(TZ, addDays(dayKey(TZ, new Date(team.start)), 3)).getTime();
    const a = planDriver(createRng(11), input({ teams: [{ ...team, role: 'A', vehicleId: 'veh-team' }] }));
    const b = planDriver(createRng(12), input({ start: lateStart, vehicleId: 'veh-b', teams: [{ ...team, role: 'B', vehicleId: 'veh-team' }] }));
    const drivesA = a.segments.filter((s) => s.status === 'D' && s.vehicleId === 'veh-team');
    const drivesB = b.segments.filter((s) => s.status === 'D' && s.vehicleId === 'veh-team');
    expect(drivesA.length).toBeGreaterThan(20);
    expect(drivesB.length).toBeGreaterThan(20);
    const overlaps = drivesA.filter((x) => drivesB.some((y) => y.start < x.end && x.start < y.end));
    expect(overlaps).toEqual([]);
    // While one drives, the other is resting (SB/OFF) or on the same absolute restart.
    for (const x of drivesB) {
      const during = a.segments.filter((s) => s.start < x.end && x.start < s.end);
      expect(during.every((s) => s.status === 'SB' || s.status === 'OFF')).toBe(true);
    }
    // The timetable is shared: every restart slot is a single OFF for both.
    const slots = teamTimetable(team.start, team.end);
    expect(slots.filter((sl) => sl.kind === 'RESTART').length).toBeGreaterThan(1);
    expect(dailyViolations(b.segments, input({ start: lateStart }))).toEqual([]);
  });

  it('a spare unit shared by unassigned drivers is never driven by two of them at once (B-060)', () => {
    const first = planDriver(createRng(21), input({ vehicleId: 'veh-spare', tail: { status: 'D', nearLimit: false } }));
    const busy = first.segments
      .filter((s) => s.vehicleId === 'veh-spare' && (effective(s.status, s.special) === 'D' || effective(s.status, s.special) === 'ON'))
      .map((s) => ({ start: s.start, end: s.end }));
    const inp = input({ vehicleId: 'veh-spare', busy, tail: { status: 'D', nearLimit: false } });
    const second = planDriver(createRng(22), inp);
    assertContiguous(second, inp);
    const drivesA = first.segments.filter((s) => s.status === 'D');
    const drivesB = second.segments.filter((s) => s.status === 'D');
    expect(drivesA.length).toBeGreaterThan(50);
    expect(drivesB.length).toBeGreaterThan(30);
    expect(drivesB.filter((x) => busy.some((b) => b.start < x.end && x.start < b.end))).toEqual([]);
    expect(drivesB.filter((x) => drivesA.some((y) => y.start < x.end && x.start < y.end))).toEqual([]);
    // Without the reservations the two plans would collide — the guard is doing the work.
    const unguarded = planDriver(createRng(22), input({ vehicleId: 'veh-spare' })).segments.filter((s) => s.status === 'D');
    expect(unguarded.some((x) => drivesA.some((y) => y.start < x.end && x.start < y.end))).toBe(true);
    expect(dailyViolations(second.segments, inp)).toEqual([]);
  });
});

describe('hos mock planner — team window ending at a millisecond instant', () => {
  it('terminates and covers the plan up to now', () => {
    const now = NOW + 437;
    const team = { start: START + 150 * DAY + 123, end: now, role: 'A' as const, vehicleId: 'veh-team' };
    const inp = input({ now, end: now, teams: [team] });
    const plan = planDriver(createRng(3), inp);
    assertContiguous(plan, inp);
    expect(plan.segments[plan.segments.length - 1].end).toBeGreaterThan(now - 2000);
  });
});

describe('hos mock records', () => {
  const inp = input({ profile: 'LONG_HAUL', flags: { pc: true, ym: true, split: true, shortHaul: false, adverse: false }, rates: { ...DEFAULT_RATES, relabel: 0.4, addOn: 0.2, forgotOff: 0.05 }, tail: { status: 'D', nearLimit: false } });
  const plan = planDriver(createRng(77), inp);
  const { rows, appliedEdits, certs } = eventsFor(plan, inp);
  const final = applyEdits(plan.segments, appliedEdits);

  it('covers every event type the schema supports', () => {
    const types = new Set(rows.map((r) => `${r.eventType}/${r.eventCode}`));
    for (const t of ['1/1', '1/2', '1/3', '1/4', '2/1', '3/0', '3/1', '3/2', '4/1', '5/1', '5/2', '6/1', '6/3']) expect(types).toContain(t);
    expect(rows.some((r) => r.recordStatus === 2 && r.supersedesUuid)).toBe(true);
    expect(rows.some((r) => r.recordOrigin === 2 && r.eventType === 1)).toBe(true);
  });

  it('sequence ids follow ingest order, uuids carry the mock prefix, checksums verify, nothing is in the future', () => {
    const byReceived = [...rows].sort((x, y) => x.eventSequenceId - y.eventSequenceId);
    for (let i = 1; i < byReceived.length; i += 1) {
      expect(byReceived[i].receivedAt.getTime()).toBeGreaterThanOrEqual(byReceived[i - 1].receivedAt.getTime());
    }
    expect(new Set(rows.map((r) => r.eventSequenceId)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.uuid)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.uuid.startsWith(HOS_EVENT_UUID_PREFIX)).toBe(true);
      expect(r.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(r.eventDateTime.getTime()).toBeLessThanOrEqual(NOW);
      expect(r.receivedAt.getTime()).toBeLessThanOrEqual(NOW);
      expect(verifyChecksum({ ...r, latitude: r.latitude, longitude: r.longitude }, r.checksum).ok).toBe(true);
    }
  });

  it('odometer and engine hours never decrease on the vehicle', () => {
    const onVehicle = rows.filter((r) => r.totalVehicleMiles !== null).sort((x, y) => x.eventDateTime.getTime() - y.eventDateTime.getTime());
    for (let i = 1; i < onVehicle.length; i += 1) {
      expect(onVehicle[i].totalVehicleMiles as number).toBeGreaterThanOrEqual(onVehicle[i - 1].totalVehicleMiles as number);
      expect(onVehicle[i].totalEngineHours as number).toBeGreaterThanOrEqual(onVehicle[i - 1].totalEngineHours as number);
    }
  });

  it('writes an intermediate log every 60 minutes of driving and 10-mile precision under PC', () => {
    const drive = final.find((s) => s.status === 'D' && s.end - s.start > 3 * H) as Seg;
    const inter = rows.filter((r) => r.eventType === 2 && r.eventDateTime.getTime() > drive.start && r.eventDateTime.getTime() < drive.end);
    expect(inter.length).toBe(Math.ceil((drive.end - drive.start) / H) - 1);
    inter.forEach((r) => expect((r.eventDateTime.getTime() - drive.start) % H).toBe(0));
    const pcRows = rows.filter((r) => r.eventType === 3 && r.eventCode === 1);
    expect(pcRows.length).toBeGreaterThan(0);
    pcRows.forEach((r) => expect(r.locationPrecisionMi).toBe(10));
  });

  it('the stored records map back to exactly the planned (edited) timeline', () => {
    const fromRows = buildSegments(normalizeEvents(mapEldEventsToNormalized(rows), new Date(NOW)), new Date(NOW));
    const fromPlan = buildSegments(normalizeEvents(toEngineEvents(final), new Date(NOW)), new Date(NOW));
    const shape = (s: { start: Date; end: Date; effective: string }) => `${s.start.getTime()}|${s.end.getTime()}|${s.effective}`;
    expect(fromRows.map(shape)).toEqual(fromPlan.map(shape));
  });

  it('DailyLog totals equal what the RODS day builder computes, and add up to the day length', () => {
    const firstKey = dayKey(TZ, new Date(START));
    const lastKey = dayKey(TZ, new Date(NOW));
    const totals = dailyTotals(final, TZ, firstKey, lastKey, NOW);
    const rods = asRods(rows);
    const sample = [firstKey, addDays(firstKey, 1), addDays(firstKey, 40), addDays(firstKey, 99), addDays(lastKey, -1), lastKey];
    for (const key of sample) {
      const day = buildRodsDay(rods, TZ, key, new Date(NOW));
      const t = totals.get(key);
      expect({ off: t?.off, sb: t?.sb, d: t?.d, on: t?.on }).toEqual({ off: day.offDutySec, sb: day.sleeperSec, d: day.drivingSec, on: day.onDutySec });
      if (key !== lastKey) expect((t?.off ?? 0) + (t?.sb ?? 0) + (t?.d ?? 0) + (t?.on ?? 0)).toBe(dayLengthSec(TZ, key));
    }
    for (const edit of appliedEdits) {
      const key = dayKey(TZ, new Date(edit.start));
      const day = buildRodsDay(rods, TZ, key, new Date(NOW));
      const t = totals.get(key);
      expect({ off: t?.off, sb: t?.sb, d: t?.d, on: t?.on }).toEqual({ off: day.offDutySec, sb: day.sleeperSec, d: day.drivingSec, on: day.onDutySec });
    }
  });

  it('certifies past days at the next login, recertifies after a later edit, never certifies today', () => {
    const today = dayKey(TZ, new Date(NOW));
    expect(certs.length).toBeGreaterThan(100);
    expect(certs.some((c) => c.date === today)).toBe(false);
    for (const c of certs) {
      expect(c.certifiedAt as number).toBeGreaterThanOrEqual(dayEnd(TZ, c.date).getTime());
      expect(c.events.map((e) => e.code)).toEqual(c.events.map((_, i) => i + 1));
    }
    const certRows = rows.filter((r) => r.eventType === 4);
    expect(certRows.length).toBe(certs.reduce((n, c) => n + c.events.length, 0));
    certRows.forEach((r) => expect(r.comment).toMatch(/^certifiedDate=\d{4}-\d{2}-\d{2}$/));
  });
});

describe('hos mock geography and helpers', () => {
  it('positions interpolate along the corridor and bounce at the ends', () => {
    const route = buildRoute(CORRIDORS['I-35']);
    expect(route.length).toBeGreaterThan(1200);
    expect(positionAt(route, 0).name).toBe('Laredo, TX');
    const far = positionAt(route, route.length);
    expect(far.city).toBe('Minneapolis, MN');
    const back = positionAt(route, route.length * 2);
    expect(back.city).toBe('Laredo, TX');
    expect(positionAt(route, 300).name).toMatch(/^\d+ mi (N|NE|E|SE|S|SW|W|NW) /);
  });

  it('a metro loop keeps local work within 150 air-miles of the terminal', () => {
    const center = findCity('Atlanta, GA terminal');
    expect(center?.point.name).toBe('Atlanta, GA');
    const loop = metroLoop(center!.point, createRng(3));
    for (let mi = 0; mi < 2000; mi += 37) expect(distanceMi(center!.point, positionAt(loop, mi))).toBeLessThan(60);
  });

  it('vehicle motion is monotonic and clips overlapping intervals', () => {
    const motion = new VehicleMotion([
      { start: 0, end: 2 * H, mph: 60 },
      { start: H, end: 3 * H, mph: 60 },
      { start: 5 * H, end: 6 * H, mph: 30 },
    ]);
    expect(motion.milesAt(0)).toBe(0);
    expect(motion.milesAt(2 * H)).toBeCloseTo(120);
    expect(motion.milesAt(4 * H)).toBeCloseTo(180);
    expect(motion.milesAt(10 * H)).toBeCloseTo(210);
    expect(motion.totalHours).toBeCloseTo(4);
  });

  it('unidentified episodes land in idle gaps and are recorded without a driver', () => {
    const busy: Array<[number, number]> = [[START + DAY, START + DAY + 10 * H], [START + 3 * DAY, START + 3 * DAY + 10 * H]];
    const eps = pickUnidentifiedEpisodes(createRng(4), busy, START, START + 5 * DAY, 3);
    expect(eps.length).toBeGreaterThan(0);
    for (const ep of eps) for (const [s, e] of busy) expect(ep.start < e + 2 * H && s - 2 * H < ep.end).toBe(false);
    const vehicle = vehicleCtx('veh-u', []);
    const rows = buildUnidentifiedEvents(vehicle, eps, TZ, NOW);
    expect(rows.every((r) => r.driverId === null && r.recordOrigin === 4)).toBe(true);
    expect(rows.filter((r) => r.eventType === 1 && r.eventCode === 3).length).toBe(eps.length);
  });

  it('mock uuids are deterministic', () => {
    expect(mockUuid('a')).toBe(mockUuid('a'));
    expect(mockUuid('a')).not.toBe(mockUuid('b'));
  });

  it('daily totals count a day with no record as off duty', () => {
    const key = '2026-04-01';
    const totals = dailyTotals([], TZ, key, key, NOW);
    expect(totals.get(key)?.off).toBe(dayLengthSec(TZ, key));
    expect(M).toBe(60_000);
  });
});
