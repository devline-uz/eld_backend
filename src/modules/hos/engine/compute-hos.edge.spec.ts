/** TZ §8.5 — time handling (DST, midnight, home terminal) and the boundary scenarios. */
import { computeHos } from './compute-hos';
import { driver, ev, H, input, M, timeline } from '../../../../test/helpers/hos';
import type { HosInput, HosState, NormalizedEvent } from '../hos.types';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

function run(steps: Parameters<typeof timeline>[1], overrides: Partial<HosInput> = {}, start = '2025-01-14T05:00:00Z'): HosState {
  const built = timeline(start, steps);
  return computeHos(input({ events: built.events, now: built.end, ...overrides }));
}
const days = (s: HosState): string[] => s.violations.map((v) => v.logDate);

describe('DST — 23-hour day (2025-03-09, America/New_York)', () => {
  const START = '2025-03-08T19:00:00Z'; // 14:00 EST on 2025-03-08

  it('a wall-clock day that is 23 hours long still allows only 11 h of driving', () => {
    const state = run([[10 * H, 'OFF'], [11 * H, 'D']], {}, START);
    expect(state.driveRemainingSec).toBe(0);
    expect(state.violations.map((v) => v.type)).toEqual(['BREAK_30']);
  });

  it('counts real elapsed hours, not wall-clock hours, across the transition', () => {
    // 00:00 EST → 12:00 EDT on 2025-03-09 reads as 12 hours but is only 11.
    const events: NormalizedEvent[] = [ev('2025-03-09T05:00:00Z', 'D')];
    const state = computeHos(input({ events, now: new Date('2025-03-09T16:00:00Z'), timezone: NY }));
    expect(state.driveUsedSec).toBe(11 * H);
    expect(state.dailyTotals.drive).toBe(11 * H);
  });

  it('bills the whole 23-hour day to one log date', () => {
    const events: NormalizedEvent[] = [ev('2025-03-09T05:00:00Z', 'ON')];
    const state = computeHos(input({ events, now: new Date('2025-03-10T03:59:59Z'), timezone: NY }));
    expect(state.dailyTotals.on).toBe(23 * H - 1);
  });

  it('closes the 14-hour window 14 real hours after the shift starts', () => {
    const events: NormalizedEvent[] = [ev('2025-03-09T04:00:00Z', 'ON')];
    const state = computeHos(input({ events, now: new Date('2025-03-09T06:00:00Z'), timezone: NY }));
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-03-09T18:00:00.000Z');
  });

  it('applies the cycle to the shortened day', () => {
    const events: NormalizedEvent[] = [ev('2025-03-09T05:00:00Z', 'ON')];
    const state = computeHos(input({ events, now: new Date('2025-03-10T04:00:00Z'), timezone: NY, previousDays: [{ date: '2025-03-08', onDutySec: 50 * H }] }));
    expect(state.cycleRemainingSec).toBe(0);
  });
});

describe('DST — 25-hour day (2025-11-02, America/New_York)', () => {
  it('counts the repeated hour as real driving time', () => {
    const events: NormalizedEvent[] = [ev('2025-11-02T04:00:00Z', 'D')];
    const state = computeHos(input({ events, now: new Date('2025-11-02T16:00:00Z'), timezone: NY }));
    expect(state.driveUsedSec).toBe(12 * H);
    expect(state.violations.map((v) => v.type)).toEqual(['BREAK_30', 'DRIVING_11']);
  });

  it('bills all 25 hours to one log date', () => {
    const events: NormalizedEvent[] = [ev('2025-11-02T04:00:00Z', 'ON')];
    const state = computeHos(input({ events, now: new Date('2025-11-03T04:59:59Z'), timezone: NY }));
    expect(state.dailyTotals.on).toBe(25 * H - 1);
  });

  it('does not stretch the 14-hour window on a 25-hour day', () => {
    const events: NormalizedEvent[] = [ev('2025-11-02T04:00:00Z', 'ON')];
    const state = computeHos(input({ events, now: new Date('2025-11-02T06:00:00Z'), timezone: NY }));
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-11-02T18:00:00.000Z');
  });

  it('does not stretch the 10-hour reset on a 25-hour day', () => {
    const events: NormalizedEvent[] = [ev('2025-11-01T20:00:00Z', 'D'), ev('2025-11-02T00:00:00Z', 'OFF'), ev('2025-11-02T10:00:00Z', 'D')];
    const state = computeHos(input({ events, now: new Date('2025-11-02T12:00:00Z'), timezone: NY }));
    expect(state.driveUsedSec).toBe(2 * H);
  });
});

describe('midnight rollover and the home terminal timezone', () => {
  it('splits a shift that crosses local midnight across two log dates', () => {
    const state = run([[10 * H, 'OFF'], [12 * H, 'D']], {}, '2025-01-14T12:00:00Z');
    expect(state.dailyTotals.drive).toBe(5 * H);
  });

  it('dates a violation by the day it happened on, not the day the shift started', () => {
    const events: NormalizedEvent[] = [ev('2025-01-14T05:00:00Z', 'OFF'), ev('2025-01-14T22:00:00Z', 'D')];
    const state = computeHos(input({ events, now: new Date('2025-01-15T10:00:00Z'), timezone: NY }));
    expect(days(state)).toEqual(['2025-01-15', '2025-01-15']);
  });

  it('dates the same violation differently for a west-coast home terminal', () => {
    const events: NormalizedEvent[] = [ev('2025-01-14T05:00:00Z', 'OFF'), ev('2025-01-14T22:00:00Z', 'D')];
    const state = computeHos(input({ events, now: new Date('2025-01-15T10:00:00Z'), timezone: LA }));
    expect(days(state)).toEqual(['2025-01-14', '2025-01-15']);
  });

  it('uses the home terminal timezone for the daily totals, never the carrier one', () => {
    const events: NormalizedEvent[] = [ev('2025-01-14T22:00:00Z', 'D')];
    const ny = computeHos(input({ events, now: new Date('2025-01-15T10:00:00Z'), timezone: NY }));
    const la = computeHos(input({ events, now: new Date('2025-01-15T10:00:00Z'), timezone: LA }));
    expect(ny.dailyTotals.drive).toBe(5 * H);
    expect(la.dailyTotals.drive).toBe(2 * H);
  });

  it('assigns previous-day history by the home terminal day key', () => {
    const state = run([[10 * H, 'OFF'], [2 * H, 'ON']], { timezone: LA, previousDays: [{ date: '2025-01-13', onDutySec: 10 * H }] });
    expect(state.cycleRemainingSec).toBe(58 * H);
  });

  it('handles a UTC home terminal', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'ON']], { timezone: 'UTC' }).cycleRemainingSec).toBe(68 * H);
  });

  it('handles a non-US home terminal', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'ON']], { timezone: 'Europe/Warsaw' }).cycleRemainingSec).toBe(68 * H);
  });
});

describe('boundary inputs', () => {
  it('handles an empty event list', () => {
    const state = computeHos(input());
    expect(state).toMatchObject({ currentStatus: 'OFF', driveUsedSec: 0, violations: [], shiftStartedAt: null });
  });

  it('uses `now` as statusSince for an empty event list', () => {
    const now = new Date('2025-01-14T12:00:00Z');
    expect(computeHos(input({ now })).statusSince).toEqual(now);
  });

  it('handles a single event', () => {
    const state = computeHos(input({ events: [ev('2025-01-14T06:00:00Z', 'D')], now: new Date('2025-01-14T12:00:00Z') }));
    expect(state.driveUsedSec).toBe(6 * H);
  });

  it('handles a single event landing exactly on `now`', () => {
    const now = new Date('2025-01-14T12:00:00Z');
    const state = computeHos(input({ events: [ev('2025-01-14T12:00:00Z', 'D')], now }));
    expect(state).toMatchObject({ currentStatus: 'D', driveUsedSec: 0 });
    expect(state.shiftStartedAt).toEqual(now);
  });

  it('ignores events dated in the future', () => {
    const state = computeHos(input({
      events: [ev('2025-01-14T06:00:00Z', 'D'), ev('2025-01-20T06:00:00Z', 'OFF')],
      now: new Date('2025-01-14T12:00:00Z'),
    }));
    expect(state.currentStatus).toBe('D');
    expect(state.driveUsedSec).toBe(6 * H);
  });

  it('ignores records whose recordStatus is not 1', () => {
    const state = computeHos(input({
      events: [ev('2025-01-14T06:00:00Z', 'D'), { ...ev('2025-01-14T08:00:00Z', 'OFF'), recordStatus: 3 }],
      now: new Date('2025-01-14T12:00:00Z'),
    }));
    expect(state.driveUsedSec).toBe(6 * H);
  });

  it('accepts unsorted input', () => {
    const state = computeHos(input({
      events: [ev('2025-01-14T08:00:00Z', 'D'), ev('2025-01-14T06:00:00Z', 'OFF')],
      now: new Date('2025-01-14T12:00:00Z'),
    }));
    expect(state.driveUsedSec).toBe(4 * H);
  });

  it('handles 10 000 events without falling over', () => {
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    const events: NormalizedEvent[] = Array.from({ length: 10_000 }, (_, i) => ({
      at: new Date(base + i * 5 * 60_000),
      status: (['OFF', 'D', 'ON', 'SB'] as const)[i % 4],
    }));
    const now = new Date(base + 10_000 * 5 * 60_000);
    const started = Date.now();
    const state = computeHos(input({ events, now }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(state.driveUsedSec).toBeGreaterThan(0);
  });

  it('is deterministic — the same input always yields the same state', () => {
    const built = timeline('2025-01-14T05:00:00Z', [[10 * H, 'OFF'], [8 * H, 'D'], [30 * M, 'OFF'], [4 * H, 'D']]);
    const first = computeHos(input({ events: built.events, now: built.end }));
    const second = computeHos(input({ events: built.events, now: built.end }));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not mutate the input events', () => {
    const built = timeline('2025-01-14T05:00:00Z', [[10 * H, 'OFF'], [4 * H, 'D']]);
    const snapshot = JSON.stringify(built.events);
    computeHos(input({ events: built.events, now: built.end }));
    expect(JSON.stringify(built.events)).toBe(snapshot);
  });

  it('tolerates an empty previousDays array', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'ON']], { previousDays: [] }).cycleRemainingSec).toBe(68 * H);
  });

  it('tolerates a missing previousDays array', () => {
    const state = computeHos({ ...input(), previousDays: undefined as unknown as [] });
    expect(state.cycleRemainingSec).toBe(70 * H);
  });

  it('tolerates a driver config with no exception flags at all', () => {
    const state = run([[10 * H, 'OFF'], [2 * H, 'D']], { driver: { driverId: 'bare' } });
    expect(state.driveUsedSec).toBe(2 * H);
  });

  it('treats a missing splitSleeperEnabled flag as enabled', () => {
    // Enabled ⇒ the pair closes and the §395.1(g)(1) look-back applies: 4 h carried + 1 h = 5 h.
    // Disabled would leave the same 5 h but with a stretched-out window, so the window start is
    // what actually distinguishes the two.
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']], { driver: { driverId: 'bare' } });
    expect(state.driveUsedSec).toBe(5 * H);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-14T13:00:00.000Z');
  });
});

describe('§8.2 rules 10/11 — personal conveyance and yard move', () => {
  // PC/YM only take effect for a driver authorised to use them (Driver.allowPersonalConveyance /
  // allowYardMove, absent ⇒ false — B-131).
  const allowed = { driver: driver({ allowPersonalConveyance: true, allowYardMove: true }) };
  const runAllowed = (steps: Parameters<typeof timeline>[1]): HosState => run(steps, allowed);

  it('PC time is never driving time', () => {
    expect(runAllowed([[10 * H, 'OFF'], [6 * H, 'D', 'PC'], [2 * H, 'D']]).driveUsedSec).toBe(2 * H);
  });

  it('PC time does not count against the cycle', () => {
    expect(runAllowed([[10 * H, 'OFF'], [6 * H, 'D', 'PC']]).cycleRemainingSec).toBe(70 * H);
  });

  it('PC time does not start the 14-hour window', () => {
    expect(runAllowed([[10 * H, 'OFF'], [6 * H, 'D', 'PC']]).shiftStartedAt).toBeNull();
  });

  it('10 hours of PC is a valid reset', () => {
    const state = runAllowed([[10 * H, 'OFF'], [5 * H, 'D'], [10 * H, 'D', 'PC'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(2 * H);
  });

  it('PC satisfies the 30-minute break', () => {
    expect(runAllowed([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'D', 'PC'], [5 * H, 'D']]).violations).toEqual([]);
  });

  it('carries the 10-mile PC location precision through normalisation', () => {
    const state = runAllowed([[10 * H, 'OFF'], [2 * H, 'D', 'PC']]);
    expect(state.dailyTotals.off).toBe(12 * H);
  });

  it('YM time is never driving time', () => {
    expect(runAllowed([[10 * H, 'OFF'], [6 * H, 'D', 'YM'], [2 * H, 'D']]).driveUsedSec).toBe(2 * H);
  });

  it('YM time does count against the cycle', () => {
    expect(runAllowed([[10 * H, 'OFF'], [6 * H, 'D', 'YM']]).cycleRemainingSec).toBe(64 * H);
  });

  it('YM time starts the 14-hour window', () => {
    expect(runAllowed([[10 * H, 'OFF'], [6 * H, 'D', 'YM']]).shiftStartedAt?.toISOString()).toBe('2025-01-14T15:00:00.000Z');
  });

  it('YM time never counts as rest', () => {
    const state = runAllowed([[10 * H, 'OFF'], [5 * H, 'D'], [10 * H, 'OFF', 'YM'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(7 * H);
  });

  it('YM does not satisfy a 10-hour reset but does satisfy the 30-minute break', () => {
    expect(runAllowed([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'D', 'YM'], [5 * H, 'D']]).violations).toEqual([]);
  });
  it('unauthorised PC is driving time — the recorded status stands', () => {
    const state = run([[10 * H, 'OFF'], [6 * H, 'D', 'PC'], [2 * H, 'D']], { driver: driver({ allowPersonalConveyance: false }) });
    expect(state.driveUsedSec).toBe(8 * H);
    expect(state.currentStatus).toBe('D');
  });

  it('an absent allowPersonalConveyance flag means not authorised', () => {
    expect(run([[10 * H, 'OFF'], [6 * H, 'D', 'PC'], [2 * H, 'D']]).driveUsedSec).toBe(8 * H);
  });

  it('unauthorised PC is not a 10-hour reset', () => {
    const state = run([[10 * H, 'OFF'], [1 * H, 'D'], [10 * H, 'D', 'PC']]);
    expect(state.driveUsedSec).toBe(11 * H);
    // 11 h of driving without a 30-minute interruption: the PC-tagged driving did not rest anything.
    expect(state.violations.map((v) => v.type)).toEqual(['BREAK_30']);
  });

  it('unauthorised PC tagged on an OFF record stays off duty', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'OFF', 'PC']]).dailyTotals.off).toBe(12 * H);
  });

  it('unauthorised YM is driving time — the recorded status stands', () => {
    const state = run([[10 * H, 'OFF'], [2 * H, 'D', 'YM'], [6 * H, 'D']], { driver: driver({ allowYardMove: false }) });
    expect(state.driveUsedSec).toBe(8 * H);
  });

  it('an absent allowYardMove flag means not authorised', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'D', 'YM']]).currentStatus).toBe('D');
  });

  it('PC authorisation does not authorise YM, and vice versa', () => {
    const pcOnly = driver({ allowPersonalConveyance: true });
    expect(run([[10 * H, 'OFF'], [2 * H, 'D', 'YM']], { driver: pcOnly }).driveUsedSec).toBe(2 * H);
    const ymOnly = driver({ allowYardMove: true });
    expect(run([[10 * H, 'OFF'], [2 * H, 'D', 'PC']], { driver: ymOnly }).driveUsedSec).toBe(2 * H);
  });
});

describe('passenger-carrying rulesets', () => {
  it('allows 10 hours of driving', () => {
    expect(run([[10 * H, 'OFF'], [10 * H, 'D']], { ruleset: 'US_70_8_PASSENGER' }).violations).toEqual([]);
  });

  it('violates past 10 hours', () => {
    const state = run([[10 * H, 'OFF'], [10 * H + 60, 'D']], { ruleset: 'US_70_8_PASSENGER' });
    expect(state.violations.map((v) => v.type)).toEqual(['DRIVING_11']);
  });

  it('allows a 15-hour window', () => {
    expect(run([[10 * H, 'OFF'], [5 * H, 'ON'], [9 * H, 'D'], [1 * H, 'D']], { ruleset: 'US_70_8_PASSENGER' }).shiftRemainingSec).toBe(0);
  });

  it('combines with the 60/7 cycle', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'ON']], { ruleset: 'US_60_7_PASSENGER' });
    expect(state.cycleRemainingSec).toBe(55 * H);
  });
});

describe('adverse driving combinations', () => {
  it('extends both clocks at once', () => {
    const state = run([[10 * H, 'OFF'], [2 * H, 'ON'], [8 * H, 'D'], [30 * M, 'OFF'], [5 * H, 'D']], { driver: driver({ adverseDrivingEnabled: true }) });
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(13 * H);
  });

  it('still catches a driver who exceeds both extended limits', () => {
    const state = run([[10 * H, 'OFF'], [2 * H, 'ON'], [8 * H, 'D'], [30 * M, 'OFF'], [6 * H, 'D']], { driver: driver({ adverseDrivingEnabled: true }) });
    expect(state.violations.map((v) => v.type).sort()).toEqual(['DRIVING_11', 'SHIFT_14']);
  });

  it('combines with the split-sleeper exception', () => {
    // Look-back total is 4 h + 8 h = 12 h of driving: over the 11 h limit, legal only because
    // adverse conditions extend it to 13 h. The window is 16 h from 13:00Z plus the excluded
    // 2 h second part, so nothing overruns it either.
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [8 * H, 'D']], { driver: driver({ adverseDrivingEnabled: true }) });
    expect(state.driveUsedSec).toBe(12 * H);
    expect(state.violations).toEqual([]);
  });

  it('does not let adverse conditions hide the look-back overrun', () => {
    // Same timeline without the adverse exception: the 12 h look-back total breaks the 11 h limit.
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [8 * H, 'D']]);
    expect(state.violations.map((v) => v.type)).toEqual(['DRIVING_11']);
    expect(state.violations[0].exceededBySec).toBe(1 * H);
  });

  it('combines with the short-haul exception', () => {
    const state = run([[10 * H, 'OFF'], [13 * H, 'D']], { driver: driver({ adverseDrivingEnabled: true, shortHaulException: true }) });
    expect(state.violations).toEqual([]);
  });
});
