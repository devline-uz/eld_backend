/**
 * Engine 1.0.3 — passenger-carrying rulesets (US_70_8_PASSENGER / US_60_7_PASSENGER), 49 CFR §395.5:
 *   (a)(1) no more than 10 h driving following 8 consecutive hours off duty;
 *   (a)(2) no driving after 15 h ON DUTY following 8 consecutive hours off duty — off-duty time does
 *          not count toward the 15, it is not an elapsed window;
 *   (b)    no driving after 60 h / 7 days or 70 h / 8 days on duty;
 *   §395.3(c) — the 34 h restart is property-only; §395.1(g)(3) — sleeper berth: two SB periods,
 *          each ≥ 2 h, together ≥ 8 h; no 30-minute break.
 */
import { computeHos } from './compute-hos';
import { PASSENGER_SPLIT, PROPERTY_SPLIT, RESET_REST, RESET_REST_PASSENGER, resolveLimits } from './limits';
import { buildSegments, findRestRuns, normalizeEvents, qualifiesAsLongPart, qualifiesAsShortPart } from './normalize';
import { analyzeSplits, classifyPart, partsPair } from './split-sleeper';
import { at, driver, H, input, M, timeline } from '../../../../test/helpers/hos';
import type { HosInput, HosRuleset, HosState } from '../hos.types';

const START = '2025-01-14T05:00:00Z'; // 00:00 local, America/New_York (EST)

function run(steps: Parameters<typeof timeline>[1], overrides: Partial<HosInput> = {}, ruleset: HosRuleset = 'US_70_8_PASSENGER'): HosState {
  const built = timeline(START, steps);
  return computeHos(input({ events: built.events, now: built.end, ruleset, ...overrides }));
}

const of = (state: HosState, type: string) => state.violations.find((v) => v.type === type);
const types = (state: HosState): string[] => state.violations.map((v) => v.type);

describe('passenger limits (§395.5)', () => {
  it.each<HosRuleset>(['US_70_8_PASSENGER', 'US_60_7_PASSENGER'])('%s: 10 h / 15 h on duty / 8 h reset / no restart', (ruleset) => {
    const limits = resolveLimits(ruleset, driver());
    expect(limits).toMatchObject({
      driveLimitSec: 10 * H,
      shiftLimitSec: 15 * H,
      shiftMode: 'ON_DUTY',
      resetRestSec: 8 * H,
      restartAllowed: false,
      breakRequired: false,
      split: PASSENGER_SPLIT,
    });
  });

  it.each<HosRuleset>(['US_70_8_PROPERTY', 'US_60_7_PROPERTY'])('%s keeps the property shape', (ruleset) => {
    expect(resolveLimits(ruleset, driver())).toMatchObject({ shiftMode: 'WINDOW', resetRestSec: 10 * H, restartAllowed: true, split: PROPERTY_SPLIT });
  });

  it('passenger split: two SB periods ≥ 2 h, ≥ 8 h together, OFF never qualifies', () => {
    expect(PASSENGER_SPLIT).toEqual({ longMinSec: 2 * H, shortMinSec: 2 * H, shortMayBeOffDuty: false, pairMinSec: 8 * H });
    expect(RESET_REST_PASSENGER).toBe(8 * H);
    expect(RESET_REST).toBe(10 * H);
  });
});

describe('§395.5(a)(1) — 10 hours of driving', () => {
  it('is legal one second under the limit', () => {
    const state = run([[10 * H, 'OFF'], [10 * H - 1, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveRemainingSec).toBe(1);
  });

  it('is legal exactly at 10 h', () => {
    const state = run([[10 * H, 'OFF'], [10 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(10 * H);
    expect(state.driveRemainingSec).toBe(0);
  });

  it('flags one second over as DRIVING_11', () => {
    const state = run([[10 * H, 'OFF'], [10 * H + 1, 'D']]);
    expect(types(state)).toEqual(['DRIVING_11']);
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(1);
    expect(of(state, 'DRIVING_11')?.occurredAt.toISOString()).toBe('2025-01-15T01:00:00.000Z');
  });

  it('accumulates across off-duty breaks shorter than 8 h', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D'], [2 * H, 'OFF'], [5 * H + 60, 'D']]);
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(60);
  });

  it('does not require a 30-minute break', () => {
    const state = run([[10 * H, 'OFF'], [9 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.nextBreakDueAt).toBeNull();
    expect(state.breakRemainingSec).toBe(8 * H);
  });
});

describe('§395.5(a) — 8 consecutive hours off duty reset the counters', () => {
  it('8 h off resets driving and on-duty time', () => {
    const state = run([[10 * H, 'OFF'], [10 * H, 'D'], [8 * H, 'OFF'], [2 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(2 * H);
    expect(state.shiftRemainingSec).toBe(13 * H);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-15T09:00:00.000Z');
  });

  it('8 h in the sleeper berth resets too', () => {
    const state = run([[10 * H, 'OFF'], [10 * H, 'D'], [8 * H, 'SB'], [2 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(2 * H);
  });

  it('a consecutive OFF + SB combination of 8 h resets', () => {
    const state = run([[10 * H, 'OFF'], [10 * H, 'D'], [3 * H, 'OFF'], [5 * H, 'SB'], [2 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(2 * H);
  });

  it('7:59:59 off does not reset', () => {
    const state = run([[10 * H, 'OFF'], [10 * H, 'D'], [8 * H - 1, 'OFF'], [2 * H, 'D']]);
    expect(types(state)).toEqual(['DRIVING_11']);
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(2 * H);
  });

  it('the same 8 h is NOT a reset for a property driver (10 h there)', () => {
    const state = run([[10 * H, 'OFF'], [10 * H, 'D'], [8 * H, 'OFF'], [2 * H, 'D']], {}, 'US_70_8_PROPERTY');
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(1 * H);
  });

  it('findRestRuns honours the reset threshold it is given', () => {
    const segments = buildSegments(normalizeEvents(timeline(START, [[8 * H, 'OFF'], [1 * H, 'D']]).events, at('2025-01-14T14:00:00Z')), at('2025-01-14T14:00:00Z'));
    expect(findRestRuns(segments)[0].isFullReset).toBe(false);
    expect(findRestRuns(segments, RESET_REST_PASSENGER)[0].isFullReset).toBe(true);
  });
});

describe('§395.5(a)(2) — no driving after 15 hours ON DUTY (not an elapsed window)', () => {
  it('reports the full 15 h before the shift starts', () => {
    const state = run([[10 * H, 'OFF']]);
    expect(state.shiftRemainingSec).toBe(15 * H);
    expect(state.shiftStartedAt).toBeNull();
    expect(state.shiftEndsAt).toBeNull();
  });

  it('off-duty time inside the shift does not count toward the 15', () => {
    // 4 ON, 4 OFF, 5 ON, 5 D: 18 h elapsed, 14 h on duty.
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [4 * H, 'OFF'], [5 * H, 'ON'], [5 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.shiftRemainingSec).toBe(1 * H);
    expect(state.driveRemainingSec).toBe(1 * H);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-14T15:00:00.000Z');
  });

  it('a long elapsed day with little on-duty time is legal (property would flag SHIFT_14)', () => {
    const steps: Parameters<typeof timeline>[1] = [[10 * H, 'OFF'], [3 * H, 'D'], [6 * H, 'OFF'], [3 * H, 'D'], [6 * H, 'OFF'], [3 * H, 'D']];
    expect(run(steps).violations).toEqual([]);
    expect(types(run(steps, {}, 'US_70_8_PROPERTY'))).toContain('SHIFT_14');
  });

  it('driving that ends exactly at 15 h on duty is legal', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'ON'], [10 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.shiftRemainingSec).toBe(0);
    expect(state.driveRemainingSec).toBe(0);
  });

  it('driving one second past 15 h on duty is SHIFT_14 by one second', () => {
    const state = run([[10 * H, 'OFF'], [6 * H, 'ON'], [9 * H + 1, 'D']]);
    expect(types(state)).toEqual(['SHIFT_14']);
    expect(of(state, 'SHIFT_14')?.exceededBySec).toBe(1);
    expect(of(state, 'SHIFT_14')?.detail).toContain('on-duty limit');
  });

  it('on duty past 15 h without driving is legal', () => {
    const state = run([[10 * H, 'OFF'], [16 * H, 'ON']]);
    expect(state.violations).toEqual([]);
    expect(state.shiftRemainingSec).toBe(0);
    expect(state.driveRemainingSec).toBe(0);
  });

  it('on duty past 15 h, then driving: stamped at the start of driving, overrun at its end', () => {
    const state = run([[10 * H, 'OFF'], [16 * H, 'ON'], [30 * M, 'D']]);
    expect(of(state, 'SHIFT_14')).toMatchObject({ logDate: '2025-01-15', exceededBySec: 90 * M });
    expect(of(state, 'SHIFT_14')?.occurredAt.toISOString()).toBe('2025-01-15T07:00:00.000Z');
  });

  it('caps driveRemainingSec by the on-duty time left', () => {
    const state = run([[10 * H, 'OFF'], [12 * H, 'ON'], [1 * H, 'D']]);
    expect(state.shiftRemainingSec).toBe(2 * H);
    expect(state.driveRemainingSec).toBe(2 * H);
  });

  it('shiftEndsAt projects now + remaining on-duty time, also while resting', () => {
    const onDuty = run([[10 * H, 'OFF'], [5 * H, 'ON']]);
    expect(onDuty.shiftEndsAt?.toISOString()).toBe('2025-01-15T06:00:00.000Z');
    const resting = run([[10 * H, 'OFF'], [5 * H, 'ON'], [1 * H, 'OFF']]);
    expect(resting.shiftRemainingSec).toBe(10 * H);
    expect(resting.shiftEndsAt?.toISOString()).toBe('2025-01-15T07:00:00.000Z');
  });

  it('adverse conditions keep the existing +2 h on both limits (unchanged in 1.0.3)', () => {
    expect(resolveLimits('US_70_8_PASSENGER', driver({ adverseDrivingEnabled: true }))).toMatchObject({ driveLimitSec: 12 * H, shiftLimitSec: 17 * H });
  });
});

describe('§395.5(b) / §395.3(c) — passenger cycle, no 34-hour restart', () => {
  it('34+ h off does NOT restart the cycle', () => {
    const state = run([[36 * H, 'OFF'], [2 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 60 * H }] });
    expect(state.cycleRemainingSec).toBe(8 * H);
  });

  it('ignores lastRestartEndedAt for a passenger driver', () => {
    const state = run([[10 * H, 'OFF'], [2 * H, 'D']], {
      previousDays: [{ date: '2025-01-12', onDutySec: 60 * H }],
      lastRestartEndedAt: at('2025-01-13T12:00:00Z'),
    });
    expect(state.cycleRemainingSec).toBe(8 * H);
  });

  it('never forecasts a restart while resting', () => {
    expect(run([[4 * H, 'OFF']]).restartAvailableAt).toBeNull();
    expect(run([[4 * H, 'OFF']], {}, 'US_70_8_PROPERTY').restartAvailableAt?.toISOString()).toBe('2025-01-15T15:00:00.000Z');
  });

  it('on duty past 70 h without driving is legal', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'ON']], { previousDays: [{ date: '2025-01-13', onDutySec: 66 * H }] });
    expect(state.violations).toEqual([]);
    expect(state.cycleRemainingSec).toBe(0);
  });

  it('driving past 70 h is CYCLE_70', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 66 * H }] });
    expect(of(state, 'CYCLE_70')).toMatchObject({ logDate: '2025-01-14', exceededBySec: 1 * H });
  });

  it('driving past 60 h is CYCLE_60 on the 60/7 passenger ruleset', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'D']], { previousDays: [{ date: '2025-01-13', onDutySec: 57 * H }] }, 'US_60_7_PASSENGER');
    expect(of(state, 'CYCLE_60')).toMatchObject({ logDate: '2025-01-14', exceededBySec: 1 * H });
  });
});

describe('§395.1(g)(3) — passenger sleeper berth', () => {
  it('5 h SB + 3 h SB pair: the counters look back to the end of the first period', () => {
    const state = run([[10 * H, 'OFF'], [6 * H, 'D'], [5 * H, 'SB'], [3 * H, 'D'], [3 * H, 'SB'], [6 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(9 * H);
    expect(state.shiftRemainingSec).toBe(6 * H);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-15T02:00:00.000Z');
  });

  it('4 h + 4 h pair', () => {
    expect(run([[10 * H, 'OFF'], [5 * H, 'D'], [4 * H, 'SB'], [4 * H, 'D'], [4 * H, 'SB'], [5 * H, 'D']]).violations).toEqual([]);
  });

  it('2 h + 6 h pair (exactly 8 h, shortest legal part)', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D'], [2 * H, 'SB'], [4 * H, 'D'], [6 * H, 'SB'], [5 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(9 * H);
  });

  it('an off-duty period never qualifies as a part', () => {
    const state = run([[10 * H, 'OFF'], [6 * H, 'D'], [5 * H, 'SB'], [3 * H, 'D'], [3 * H, 'OFF'], [6 * H, 'D']]);
    expect(types(state)).toEqual(['DRIVING_11']);
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(5 * H);
  });

  it('a part of 1:59 does not qualify, even when the two add up to 8 h', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'D'], [6 * H + M, 'SB'], [3 * H, 'D'], [2 * H - M, 'SB'], [4 * H, 'D']]);
    expect(types(state)).toEqual(['DRIVING_11']);
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(1 * H);
  });

  it('two parts totalling 7:59:59 do not pair', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D'], [4 * H, 'SB'], [4 * H, 'D'], [4 * H - 1, 'SB'], [5 * H, 'D']]);
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(4 * H);
  });

  it('the qualifying part is the continuous SB stretch inside a mixed OFF/SB run', () => {
    const state = run([[10 * H, 'OFF'], [6 * H, 'D'], [1 * H, 'OFF'], [5 * H, 'SB'], [3 * H, 'D'], [3 * H, 'SB'], [6 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(9 * H);
  });

  it('each part belongs to exactly one pair (three consecutive parts)', () => {
    const state = run([[10 * H, 'OFF'], [3 * H, 'D'], [4 * H, 'SB'], [3 * H, 'D'], [4 * H, 'SB'], [3 * H, 'D'], [4 * H, 'SB'], [3 * H, 'D']]);
    expect(state.violations).toEqual([]);
    expect(state.driveUsedSec).toBe(9 * H);
  });

  it('the on-duty counter also looks back (ON between the periods carries over)', () => {
    const state = run([[10 * H, 'OFF'], [6 * H, 'ON'], [5 * H, 'SB'], [4 * H, 'ON'], [3 * H, 'SB'], [11 * H, 'ON'], [1 * H, 'D']]);
    // look-back: 4 h ON; then 11 h ON + 1 h D = 16 h on duty → the last hour of driving is past 15 h.
    expect(of(state, 'SHIFT_14')?.exceededBySec).toBe(1 * H);
  });

  it('honours splitSleeperEnabled = false', () => {
    const state = run([[10 * H, 'OFF'], [6 * H, 'D'], [5 * H, 'SB'], [3 * H, 'D'], [3 * H, 'SB'], [6 * H, 'D']], { driver: driver({ splitSleeperEnabled: false }) });
    expect(of(state, 'DRIVING_11')?.exceededBySec).toBe(5 * H);
  });

  it('classifyPart / partsPair / analyzeSplits apply the passenger thresholds', () => {
    const built = timeline(START, [[10 * H, 'OFF'], [1 * H, 'D'], [3 * H, 'OFF'], [1 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D'], [6 * H, 'SB'], [1 * H, 'D']]);
    const segments = buildSegments(normalizeEvents(built.events, built.end), built.end);
    const runs = findRestRuns(segments, RESET_REST_PASSENGER);
    const [, offRun, sb2, sb6] = runs;
    expect(qualifiesAsShortPart(offRun, PASSENGER_SPLIT)).toBe(false);
    expect(qualifiesAsShortPart(offRun)).toBe(true);
    expect(classifyPart(offRun, PASSENGER_SPLIT)).toBeNull();
    expect(qualifiesAsLongPart(sb2, PASSENGER_SPLIT)).toBe(true);
    expect(qualifiesAsLongPart(sb2)).toBe(false);
    const a = classifyPart(sb2, PASSENGER_SPLIT);
    const b = classifyPart(sb6, PASSENGER_SPLIT);
    expect(a?.kind).toBe('LONG');
    expect(partsPair(a!, b!, PASSENGER_SPLIT)).toBe(true);
    expect(partsPair(a!, b!)).toBe(false);
    expect(analyzeSplits(runs, true, PASSENGER_SPLIT).pairs).toHaveLength(1);
  });
});
