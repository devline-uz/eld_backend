/** TZ §8.2 rules 1/2/3 — driving limit, 14-hour window and 30-minute break end to end. */
import { computeHos } from './compute-hos';
import { driver, H, input, M, timeline } from '../../../../test/helpers/hos';
import type { HosInput, HosState } from '../hos.types';

const START = '2025-01-14T05:00:00Z';

function run(steps: Parameters<typeof timeline>[1], overrides: Partial<HosInput> = {}, start = START): HosState {
  const built = timeline(start, steps);
  return computeHos(input({ events: built.events, now: built.end, ...overrides }));
}

const types = (state: HosState): string[] => state.violations.map((v) => v.type);
const of = (state: HosState, type: string) => state.violations.find((v) => v.type === type);

describe('§8.2 rule 1 — 11 hours of driving', () => {
  it('reports 11 h remaining before any driving', () => {
    expect(run([[10 * H, 'OFF']]).driveRemainingSec).toBe(11 * H);
  });

  it('counts driving against the limit', () => {
    expect(run([[10 * H, 'OFF'], [3 * H, 'D']]).driveUsedSec).toBe(3 * H);
  });

  it('is legal one second under the limit', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [30 * M, 'OFF'], [3 * H - 1, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveRemainingSec).toBe(1);
  });

  it('is legal exactly at 11 h', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [30 * M, 'OFF'], [3 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveRemainingSec).toBe(0);
  });

  it('violates one second over the limit', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [30 * M, 'OFF'], [3 * H + 1, 'D']]);
    expect(types(state)).toEqual(['DRIVING_11']);
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(1);
  });

  it('reports the overrun in seconds', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [30 * M, 'OFF'], [3 * H + 26 * M, 'D']]);
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(26 * M);
  });

  it('records when the limit was crossed, not when the shift ended', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [30 * M, 'OFF'], [4 * H, 'D']]);
    expect(of(state, 'DRIVING_11')?.occurredAt.toISOString()).toBe('2025-01-15T02:30:00.000Z');
  });

  it('never lets driveRemainingSec go negative', () => {
    expect(run([[10 * H, 'OFF'], [13 * H, 'D']]).driveRemainingSec).toBe(0);
  });

  it('resets driving time after 10 h off duty', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [10 * H, 'OFF'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(2 * H);
  });

  it('does not reset after 9:59 off duty', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [10 * H - 60, 'OFF'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(10 * H);
  });

  it('raises the limit to 13 h with the adverse-conditions exception', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [30 * M, 'OFF'], [5 * H, 'D']], { driver: driver({ adverseDrivingEnabled: true }) });
    expect(state.violations).toEqual([]);
  });

  it('still violates past 13 h with the adverse exception', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D'], [30 * M, 'OFF'], [5 * H + 60, 'D']], { driver: driver({ adverseDrivingEnabled: true }) });
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(60);
  });

  it('never reduces driving time through any path', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'OFF'], [4 * H, 'D'], [30 * M, 'ON'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(10 * H);
  });
});

describe('§8.2 rule 2 — the 14-hour window', () => {
  it('starts at the first on-duty record', () => {
    expect(run([[10 * H, 'OFF'], [1 * H, 'ON'], [1 * H, 'D']]).shiftStartedAt?.toISOString()).toBe('2025-01-14T15:00:00.000Z');
  });

  it('starts at driving when the driver never went on duty first', () => {
    expect(run([[10 * H, 'OFF'], [1 * H, 'D']]).shiftStartedAt?.toISOString()).toBe('2025-01-14T15:00:00.000Z');
  });

  it('is null before the shift starts', () => {
    expect(run([[4 * H, 'OFF']]).shiftStartedAt).toBeNull();
  });

  it('ends 14 h after the shift start', () => {
    expect(run([[10 * H, 'OFF'], [1 * H, 'ON']]).shiftEndsAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });

  it('does not pause for off-duty time inside the shift', () => {
    const state = run([[10 * H, 'OFF'], [1 * H, 'ON'], [4 * H, 'OFF'], [1 * H, 'D']]);
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });

  it('does not pause for a 3-hour sleeper period that cannot qualify', () => {
    const state = run([[10 * H, 'OFF'], [1 * H, 'ON'], [3 * H, 'SB'], [1 * H, 'D']]);
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });

  it('is legal when driving ends exactly at the 14 h mark', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [7 * H, 'D'], [30 * M, 'OFF'], [2.5 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.shiftRemainingSec).toBe(0);
  });

  it('violates when driving continues one second past the window', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [7 * H, 'D'], [30 * M, 'OFF'], [2.5 * H + 1, 'D']]);
    expect(types(state)).toEqual(['SHIFT_14']);
    expect(of(state, 'SHIFT_14')?.exceededBySec).toBe(1);
  });

  it('reports how far past the window the driver drove', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [7 * H, 'D'], [36 * M, 'OFF'], [3 * H, 'D']]);
    expect(of(state, 'SHIFT_14')?.exceededBySec).toBe(36 * M);
  });

  it('records the violation at the moment the window closed', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [7 * H, 'D'], [36 * M, 'OFF'], [3 * H, 'D']]);
    expect(of(state, 'SHIFT_14')?.occurredAt.toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });

  it('does not raise SHIFT_14 for on-duty work after the window', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [7 * H, 'D'], [4 * H, 'ON']]);
    expect(types(state)).not.toContain('SHIFT_14');
  });

  it('raises the window to 16 h with the adverse exception', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [7 * H, 'D'], [36 * M, 'OFF'], [3 * H, 'D']], { driver: driver({ adverseDrivingEnabled: true }) });
    expect(state.violations).toEqual([]);
  });

  it('resets the window after 10 h off duty', () => {
    const state = run([[10 * H, 'OFF'], [6 * H, 'ON'], [10 * H, 'OFF'], [1 * H, 'D']]);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-15T07:00:00.000Z');
  });

  it('reports the full window when no shift has started', () => {
    expect(run([[4 * H, 'OFF']]).shiftRemainingSec).toBe(14 * H);
  });

  it('never lets shiftRemainingSec go negative', () => {
    expect(run([[10 * H, 'OFF'], [16 * H, 'ON']]).shiftRemainingSec).toBe(0);
  });

  it('caps driveRemainingSec by the window', () => {
    const state = run([[10 * H, 'OFF'], [12 * H, 'ON']]);
    expect(state.shiftRemainingSec).toBe(2 * H);
    expect(state.driveRemainingSec).toBe(2 * H);
  });
});

describe('§8.2 rule 3 — the 30-minute break', () => {
  it('reports 8 h of driving before a break is due', () => {
    expect(run([[10 * H, 'OFF']]).breakRemainingSec).toBe(8 * H);
  });

  it('counts down as the driver drives', () => {
    expect(run([[10 * H, 'OFF'], [3 * H, 'D']]).breakRemainingSec).toBe(5 * H);
  });

  it('is legal at exactly 8 h of driving', () => {
    const state = run([[10 * H, 'OFF'], [8 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.breakRemainingSec).toBe(0);
  });

  it('is legal at 7:59', () => {
    expect(run([[10 * H, 'OFF'], [8 * H - 60, 'D']]).violations).toEqual([]);
  });

  it('violates one second past 8 h', () => {
    const state = run([[10 * H, 'OFF'], [8 * H + 1, 'D']]);
    expect(types(state)).toEqual(['BREAK_30']);
    expect(of(state, 'BREAK_30')?.exceededBySec).toBe(1);
  });

  it('records the moment the 8th hour passed', () => {
    const state = run([[10 * H, 'OFF'], [9 * H, 'D']]);
    expect(of(state, 'BREAK_30')?.occurredAt.toISOString()).toBe('2025-01-14T23:00:00.000Z');
  });

  it('is not reset by a 29-minute break', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'D'], [29 * M, 'OFF'], [4 * H + 60, 'D']]);
    expect(of(state, 'BREAK_30')?.exceededBySec).toBe(60);
  });

  it('is reset by exactly 30 minutes', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'OFF'], [4 * H + 60, 'D']]);
    expect(state.violations).toEqual([]);
  });

  it('accepts a break spent on duty', () => {
    expect(run([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'ON'], [5 * H, 'D']]).violations).toEqual([]);
  });

  it('accepts a break spent in the sleeper berth', () => {
    expect(run([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'SB'], [5 * H, 'D']]).violations).toEqual([]);
  });

  it('accepts a break assembled from consecutive non-driving statuses', () => {
    expect(run([[10 * H, 'OFF'], [4 * H, 'D'], [15 * M, 'ON'], [15 * M, 'OFF'], [5 * H, 'D']]).violations).toEqual([]);
  });

  it('does not accept two separate 15-minute breaks', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'D'], [15 * M, 'OFF'], [1 * H, 'D'], [15 * M, 'OFF'], [3 * H + 60, 'D']]);
    expect(types(state)).toContain('BREAK_30');
  });

  it('reports when the break ended', () => {
    expect(run([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'OFF'], [1 * H, 'D']]).lastBreakEndedAt?.toISOString()).toBe('2025-01-14T19:30:00.000Z');
  });

  it('reports a trailing rest as the break once it reaches 30 minutes', () => {
    expect(run([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'OFF']]).lastBreakEndedAt?.toISOString()).toBe('2025-01-14T19:30:00.000Z');
  });

  it('leaves lastBreakEndedAt null in a fresh shift — the 10-hour reset is not a break inside it', () => {
    expect(run([[10 * H, 'OFF'], [4 * H, 'D'], [29 * M, 'OFF'], [1 * H, 'D']]).lastBreakEndedAt).toBeNull();
  });

  it('clears lastBreakEndedAt while the driver is still in a 10-hour reset', () => {
    expect(run([[10 * H, 'OFF'], [4 * H, 'D'], [30 * M, 'OFF'], [1 * H, 'D'], [10 * H, 'OFF']]).lastBreakEndedAt).toBeNull();
  });

  it('counts 30 minutes of on-duty right after a reset as the first break of the new shift', () => {
    expect(run([[10 * H, 'OFF'], [30 * M, 'ON'], [1 * H, 'D']]).lastBreakEndedAt?.toISOString()).toBe('2025-01-14T15:30:00.000Z');
  });

  it('leaves lastBreakEndedAt null when the driver has not rested', () => {
    expect(run([[4 * H, 'D']]).lastBreakEndedAt).toBeNull();
  });

  it('predicts when the break falls due while driving', () => {
    expect(run([[10 * H, 'OFF'], [3 * H, 'D']]).nextBreakDueAt?.toISOString()).toBe('2025-01-14T23:00:00.000Z');
  });

  it('does not predict a due time while the driver is not driving', () => {
    expect(run([[10 * H, 'OFF'], [3 * H, 'D'], [10 * M, 'ON']]).nextBreakDueAt).toBeNull();
  });

  it('reports the break as due now once 8 h are used', () => {
    const built = timeline(START, [[10 * H, 'OFF'], [8 * H, 'D']]);
    expect(computeHos(input({ events: built.events, now: built.end })).nextBreakDueAt).toEqual(built.end);
  });

  it('never requires a break from a short-haul driver', () => {
    const state = run([[10 * H, 'OFF'], [11 * H, 'D']], { driver: driver({ shortHaulException: true }) });
    expect(types(state)).not.toContain('BREAK_30');
    expect(state.nextBreakDueAt).toBeNull();
  });

  it('never requires a break from a passenger-carrying driver', () => {
    const state = run([[10 * H, 'OFF'], [9 * H, 'D']], { ruleset: 'US_70_8_PASSENGER' });
    expect(types(state)).not.toContain('BREAK_30');
  });
});

describe('current status and daily totals', () => {
  it('reports OFF for an empty timeline', () => {
    const state = computeHos(input());
    expect(state.currentStatus).toBe('OFF');
    expect(state.dailyTotals).toEqual({ off: 0, sb: 0, drive: 0, on: 0 });
  });

  it('reports the effective status of the last segment', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'D']]).currentStatus).toBe('D');
  });

  it('reports PC as off duty', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'D', 'PC']], { driver: driver({ allowPersonalConveyance: true, allowYardMove: true }) }).currentStatus).toBe('OFF');
  });

  it('reports YM as on duty', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'D', 'YM']], { driver: driver({ allowPersonalConveyance: true, allowYardMove: true }) }).currentStatus).toBe('ON');
  });

  it('reports when the current status began', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'D']]).statusSince.toISOString()).toBe('2025-01-14T15:00:00.000Z');
  });

  it('totals the RODS day in the home terminal timezone', () => {
    const state = run([[10 * H, 'OFF'], [2 * H, 'ON'], [3 * H, 'D'], [1 * H, 'SB']]);
    expect(state.dailyTotals).toEqual({ off: 10 * H, sb: 1 * H, drive: 3 * H, on: 2 * H });
  });

  it('counts PC time as off duty in the daily totals', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'D', 'PC']], { driver: driver({ allowPersonalConveyance: true, allowYardMove: true }) }).dailyTotals).toEqual({ off: 12 * H, sb: 0, drive: 0, on: 0 });
  });

  it('counts YM time as on duty in the daily totals', () => {
    expect(run([[10 * H, 'OFF'], [2 * H, 'D', 'YM']], { driver: driver({ allowPersonalConveyance: true, allowYardMove: true }) }).dailyTotals).toEqual({ off: 10 * H, sb: 0, drive: 0, on: 2 * H });
  });

  it('excludes yesterday from the daily totals', () => {
    const state = run([[10 * H, 'ON'], [10 * H, 'D']], {}, '2025-01-13T15:00:00Z');
    expect(state.dailyTotals.on).toBe(0);
    expect(state.dailyTotals.drive).toBe(6 * H);
  });
});

describe('cycle, restart and recap in the assembled state', () => {
  it('reports the full cycle with no history', () => {
    expect(computeHos(input()).cycleRemainingSec).toBe(70 * H);
  });

  it('subtracts today’s on-duty time', () => {
    expect(run([[10 * H, 'OFF'], [5 * H, 'ON']]).cycleRemainingSec).toBe(65 * H);
  });

  it('subtracts previous days', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'ON']], { previousDays: [{ date: '2025-01-13', onDutySec: 10 * H }] });
    expect(state.cycleRemainingSec).toBe(55 * H);
  });

  it('ignores a day outside the 8-day window', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'ON']], { previousDays: [{ date: '2025-01-06', onDutySec: 10 * H }] });
    expect(state.cycleRemainingSec).toBe(65 * H);
  });

  it('raises CYCLE_70 for driving past the limit', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 66 * H }] });
    expect(of(state, 'CYCLE_70')?.exceededBySec).toBe(1 * H);
  });

  it('raises CYCLE_60 for a 60/7 driver driving past the limit', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D']], { ruleset: 'US_60_7_PROPERTY', previousDays: [{ date: '2025-01-13', onDutySec: 56 * H }] });
    expect(of(state, 'CYCLE_60')?.exceededBySec).toBe(1 * H);
  });

  it('records when driving crossed the cycle limit', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 66 * H }] });
    expect(of(state, 'CYCLE_70')?.occurredAt.toISOString()).toBe('2025-01-14T19:00:00.000Z');
  });

  it('B-054: raises no cycle violation on a day with no on-duty time', () => {
    const state = run([[13 * H, 'OFF']], { previousDays: [{ date: '2025-01-13', onDutySec: 71 * H }] });
    expect(state.cycleRemainingSec).toBe(0);
    expect(of(state, 'CYCLE_70')).toBeUndefined();
  });

  it('1.0.3: on-duty hours known only from previousDays carry no driving, so no violation', () => {
    const state = run([[13 * H, 'OFF']], { previousDays: [{ date: '2025-01-13', onDutySec: 66 * H }, { date: '2025-01-14', onDutySec: 5 * H }] });
    expect(state.cycleRemainingSec).toBe(0);
    expect(of(state, 'CYCLE_70')).toBeUndefined();
  });

  it('B-054: never stamps a cycle violation after now', () => {
    const state = run([[10 * H, 'OFF'], [1 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 66 * H }, { date: '2025-01-14', onDutySec: 5 * H }] });
    const violation = of(state, 'CYCLE_70');
    expect(violation?.exceededBySec).toBe(1 * H);
    expect(violation?.occurredAt.toISOString()).toBe('2025-01-14T15:00:00.000Z');
  });

  it('caps driveRemainingSec by the cycle', () => {
    const state = run([[10 * H, 'OFF'], [1 * H, 'ON']], { previousDays: [{ date: '2025-01-13', onDutySec: 67 * H }] });
    expect(state.driveRemainingSec).toBe(2 * H);
  });

  it('zeroes the cycle after a 34-hour restart', () => {
    const state = run([[34 * H, 'OFF'], [2 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 60 * H }] });
    expect(state.cycleRemainingSec).toBe(68 * H);
  });

  it('does not restart on 33:59', () => {
    const state = run([[34 * H - 60, 'OFF'], [2 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 60 * H }] });
    expect(state.cycleRemainingSec).toBe(8 * H);
  });

  it('predicts when 34 continuous hours will be reached', () => {
    expect(run([[4 * H, 'OFF']]).restartAvailableAt?.toISOString()).toBe('2025-01-15T15:00:00.000Z');
  });

  it('reports no restart forecast while the driver is working', () => {
    expect(run([[10 * H, 'OFF'], [1 * H, 'D']]).restartAvailableAt).toBeNull();
  });

  it('reports the recap moment when hours come back tomorrow', () => {
    const state = run([[10 * H, 'OFF'], [1 * H, 'ON']], { previousDays: [{ date: '2025-01-07', onDutySec: 6 * H }] });
    expect(state.cycleRecapAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });

  it("reports today's own hours coming back after the full window when nothing drops out sooner", () => {
    // 2025-01-14 is the only day with hours; it leaves the 8-day window at the end of 2025-01-21.
    expect(run([[10 * H, 'OFF'], [1 * H, 'ON']]).cycleRecapAt?.toISOString()).toBe('2025-01-22T05:00:00.000Z');
  });

  it('reports no recap for an idle window', () => {
    expect(run([[10 * H, 'OFF']]).cycleRecapAt).toBeNull();
  });

  it('skips days before a 34-hour restart when forecasting the recap', () => {
    const state = run([[34 * H, 'OFF'], [1 * H, 'ON']], { previousDays: [{ date: '2025-01-09', onDutySec: 9 * H }] });
    // 01-09 precedes the restart; the next recap is the post-restart day 2025-01-15 leaving the window.
    expect(state.cycleRecapAt?.toISOString()).toBe('2025-01-23T05:00:00.000Z');
  });
});

/**
 * 1.0.3 — §395.3(b) prohibits DRIVING after 60/70 h on duty in 7/8 days, not being on duty, so a
 * CYCLE_* violation is recorded only for driving past the limit (like the 14-hour window).
 */
describe('§395.3(b) — the cycle is violated by driving, not by on-duty time', () => {
  const past66 = { previousDays: [{ date: '2025-01-13', onDutySec: 66 * H }] };

  it('on-duty-not-driving past 70 h is legal', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'ON']], past66);
    expect(state.cycleRemainingSec).toBe(0);
    expect(state.driveRemainingSec).toBe(0);
    expect(of(state, 'CYCLE_70')).toBeUndefined();
  });

  it('on-duty-not-driving past 60 h is legal on 60/7', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'ON']], { ruleset: 'US_60_7_PROPERTY', previousDays: [{ date: '2025-01-13', onDutySec: 56 * H }] });
    expect(state.cycleRemainingSec).toBe(0);
    expect(state.violations).toEqual([]);
  });

  it('driving that ends exactly at 70 h is legal', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'D']], past66);
    expect(state.cycleRemainingSec).toBe(0);
    expect(state.violations).toEqual([]);
  });

  it('driving one second past 70 h is a violation of one second', () => {
    const state = run([[10 * H, 'OFF'], [4 * H + 1, 'D']], past66);
    expect(of(state, 'CYCLE_70')?.exceededBySec).toBe(1);
    expect(of(state, 'CYCLE_70')?.occurredAt.toISOString()).toBe('2025-01-14T19:00:00.000Z');
  });

  it('driving that starts exactly at the limit is past it from its first second', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [1 * H, 'D']], past66);
    expect(of(state, 'CYCLE_70')).toMatchObject({ logDate: '2025-01-14', exceededBySec: 1 * H });
    expect(of(state, 'CYCLE_70')?.occurredAt.toISOString()).toBe('2025-01-14T19:00:00.000Z');
  });

  it('on duty past the limit, then driving: stamped at the start of driving, overrun at its end', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'ON'], [30 * M, 'D']], past66);
    expect(of(state, 'CYCLE_70')?.occurredAt.toISOString()).toBe('2025-01-14T20:00:00.000Z');
    expect(of(state, 'CYCLE_70')?.exceededBySec).toBe(90 * M);
  });

  it('keeps the earliest instant and the largest overrun of the day', () => {
    const state = run([[10 * H, 'OFF'], [4.5 * H, 'D'], [30 * M, 'ON'], [30 * M, 'D']], past66);
    expect(state.violations.filter((v) => v.type === 'CYCLE_70')).toHaveLength(1);
    expect(of(state, 'CYCLE_70')?.occurredAt.toISOString()).toBe('2025-01-14T19:00:00.000Z');
    expect(of(state, 'CYCLE_70')?.exceededBySec).toBe(90 * M);
  });

  it('driving across local midnight is a violation on each RODS day it touches', () => {
    // 18:00–23:00 local ON, 23:00–01:00 local D; 66 h on 01-13 stay inside both windows.
    const state = run([[18 * H, 'OFF'], [5 * H, 'ON'], [2 * H, 'D']], past66);
    const cycle = state.violations.filter((v) => v.type === 'CYCLE_70');
    expect(cycle.map((v) => [v.logDate, v.exceededBySec])).toEqual([
      ['2025-01-14', 2 * H],
      ['2025-01-15', 3 * H],
    ]);
    expect(cycle[1].occurredAt.toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });

  it('a completed 34-hour restart leaves nothing to violate', () => {
    const state = run([[34 * H, 'OFF'], [2 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 70 * H }] });
    expect(state.violations).toEqual([]);
  });

  it('previousDays hours beyond the segments count first (at the start of the day)', () => {
    // 01-14 reported as 5 h but only 1 h of segments: 4 h unknown-timing on-duty precede the driving.
    const state = run([[10 * H, 'OFF'], [1 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 66 * H }, { date: '2025-01-14', onDutySec: 5 * H }] });
    expect(of(state, 'CYCLE_70')).toMatchObject({ logDate: '2025-01-14', exceededBySec: 1 * H });
  });

  it('yard move past the limit is on duty, not driving: no violation', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D', 'YM']], { ...past66, driver: driver({ allowYardMove: true }) });
    expect(of(state, 'CYCLE_70')).toBeUndefined();
    expect(state.cycleRemainingSec).toBe(0);
  });

  it('unauthorised yard move past the limit is driving: violation', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D', 'YM']], past66);
    expect(of(state, 'CYCLE_70')?.exceededBySec).toBe(1 * H);
  });
});
