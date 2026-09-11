/**
 * 49 CFR §395.1(g)(1) — split sleeper through the full engine. Two regressions these tests
 * defend against:
 *   1. excluding only the LONGER half from the 14-hour window (the pre-2020 reading) writes a
 *      phantom SHIFT_14 violation against every driver who splits their rest;
 *   2. treating a closed pair as a full RESET (the wording in `tz.md` §8.2.1, superseded — see
 *      D-012) is more permissive than the CFR and silently loses the driving done BETWEEN the
 *      two halves, under-reporting DRIVING_11 and SHIFT_14.
 * The CFR requires a LOOK-BACK to the end of the FIRST qualifying part.
 */
import { computeHos } from './compute-hos';
import { driver, H, input, M, timeline } from '../../../../test/helpers/hos';
import type { HosInput, HosState } from '../hos.types';

const START = '2025-01-14T05:00:00Z';

function run(steps: Parameters<typeof timeline>[1], overrides: Partial<HosInput> = {}): HosState {
  const built = timeline(START, steps);
  return computeHos(input({ events: built.events, now: built.end, ...overrides }));
}
const types = (s: HosState): string[] => s.violations.map((v) => v.type);

describe('qualifying pairs', () => {
  it('8/2 closes the pair and carries the driving done between the halves', () => {
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(5 * H);
    expect(state.driveRemainingSec).toBe(6 * H);
  });

  it('8/2 restarts the 14-hour window at the end of the FIRST part, second part excluded', () => {
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-14T13:00:00.000Z');
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });

  it('7/3 qualifies', () => {
    const state = run([[7 * H, 'SB'], [4 * H, 'D'], [3 * H, 'OFF'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(5 * H);
  });

  it('7.5/2.5 qualifies', () => {
    const state = run([[7.5 * H, 'SB'], [4 * H, 'D'], [2.5 * H, 'SB'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(5 * H);
  });

  it('3/7 qualifies when the short half comes first', () => {
    // Look-back reaches the end of the 3 h OFF, so only the 1 h driven after it is carried.
    const state = run([[10 * H, 'OFF'], [1 * H, 'D'], [3 * H, 'OFF'], [1 * H, 'D'], [7 * H, 'SB'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(2 * H);
  });

  it('the short half may be off duty rather than sleeper', () => {
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'OFF'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(5 * H);
  });

  it('the long half may not be off duty', () => {
    const state = run([[8 * H, 'OFF'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(5 * H);
  });

  it('resets the break clock when the pair closes', () => {
    const state = run([[8 * H, 'SB'], [7 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]);
    expect(state.breakRemainingSec).toBe(7 * H);
  });

  it('a 6:59 sleeper period does not qualify', () => {
    const state = run([[7 * H - 60, 'SB'], [4 * H, 'D'], [3 * H, 'SB'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(5 * H);
  });

  it('7 h + 2 h is only 9 h and never closes a pair', () => {
    const state = run([[7 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(5 * H);
  });

  it('needs the driver exception to be enabled', () => {
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']], { driver: driver({ splitSleeperEnabled: false }) });
    expect(state.driveUsedSec).toBe(5 * H);
  });
});

describe('BOTH qualifying parts leave the 14-hour window', () => {
  // 4 h on duty, 5 h driving, 7 h SB, 5 h driving, 3 h off (pair closes), 4 h driving.
  const steps: Parameters<typeof timeline>[1] = [
    [10 * H, 'OFF'], [4 * H, 'ON'], [5 * H, 'D'], [7 * H, 'SB'], [5 * H, 'D'], [3 * H, 'OFF'], [4 * H, 'D'],
  ];

  it('raises no violation at all', () => {
    expect(run(steps).violations).toEqual([]);
  });

  it('would raise SHIFT_14 if the exception were off — proving the exclusion is what saves it', () => {
    expect(types(run(steps, { driver: driver({ splitSleeperEnabled: false }) }))).toContain('SHIFT_14');
  });

  it('restarts the window at the end of the FIRST part, with the second part excluded', () => {
    // First part (7 h SB) ends 2025-01-15T07:00Z; the 3 h OFF second part is excluded,
    // so the window runs 14 h + 3 h from there.
    const state = run(steps);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-15T07:00:00.000Z');
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-16T00:00:00.000Z');
  });

  it('carries the driving done between the two halves onto the 11 h clock', () => {
    // 5 h driven between the halves + 4 h driven after = 9 h, NOT the 4 h a reset would leave.
    expect(run(steps).driveUsedSec).toBe(9 * H);
  });

  it('excludes the first part while the pair is still open', () => {
    // Same timeline, stopped before the second part: the window has stretched by 7 h.
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [5 * H, 'D'], [7 * H, 'SB'], [5 * H, 'D']]);
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T12:00:00.000Z');
    expect(state.violations).toEqual([]);
  });

  it('keeps accumulating driving time while the pair is open', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [5 * H, 'D'], [7 * H, 'SB'], [5 * H, 'D']]);
    expect(state.driveUsedSec).toBe(10 * H);
  });

  it('still raises DRIVING_11 while the pair is open', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [6 * H, 'D'], [7 * H, 'SB'], [30 * M, 'OFF'], [5 * H + 60, 'D']]);
    expect(types(state)).toContain('DRIVING_11');
  });

  it('does not exclude a lone 2-hour off-duty break from the window', () => {
    const state = run([[10 * H, 'OFF'], [4 * H, 'ON'], [5 * H, 'D'], [2 * H, 'OFF'], [4 * H, 'D']]);
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
    expect(types(state)).toContain('SHIFT_14');
  });
});

describe('three consecutive parts (§8.2.1 step 3)', () => {
  const steps: Parameters<typeof timeline>[1] = [
    [8 * H, 'SB'], [3 * H, 'D'], [2 * H, 'SB'], [3 * H, 'D'], [7 * H, 'SB'], [3 * H, 'D'],
  ];

  it('pairs the first two and carries the third forward', () => {
    // Pair 1 closes after the 2 h SB; the look-back puts the window start at the end of the
    // 8 h SB (13:00Z), excluding the 2 h SB and then the still-unpaired 7 h SB.
    const state = run(steps);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-14T13:00:00.000Z');
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T12:00:00.000Z');
  });

  it('keeps the driving from before AND after the closed pair on the clock', () => {
    expect(run(steps).driveUsedSec).toBe(9 * H);
  });

  it('raises no violation across all three parts', () => {
    expect(run(steps).violations).toEqual([]);
  });

  it('closes a second pair when a fourth part arrives', () => {
    // Pair 2 = the 7 h SB + the 3 h OFF; the look-back reaches the end of the 7 h SB, so the
    // 3 h driven between them is carried and only the 10 h SB-equivalent rest is excluded.
    const state = run([...steps, [3 * H, 'OFF'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(5 * H);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-15T04:00:00.000Z');
  });
});

describe('unclosed pairs and full resets', () => {
  it('a 7-hour sleeper period alone never resets the driving clock', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D'], [7 * H, 'SB'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(7 * H);
  });

  it('a 10-hour rest is a full reset, not a split part', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D'], [10 * H, 'SB'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(2 * H);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-15T06:00:00.000Z');
  });

  it('a full reset discards a half-built pair', () => {
    const state = run([[8 * H, 'SB'], [3 * H, 'D'], [10 * H, 'OFF'], [3 * H, 'D'], [2 * H, 'SB'], [3 * H, 'D']]);
    expect(state.driveUsedSec).toBe(6 * H);
  });

  it('9:59 of rest is not a full reset', () => {
    const state = run([[10 * H, 'OFF'], [5 * H, 'D'], [10 * H - 60, 'OFF'], [2 * H, 'D']]);
    expect(state.driveUsedSec).toBe(7 * H);
  });
});

/**
 * The cases where the §395.1(g)(1) LOOK-BACK and the superseded `tz.md` §8.2.1 RESET give
 * different answers: a driver who WORKS between the two halves of the pair. Under the reset
 * reading every one of these comes back clean, which is exactly the under-reporting D-012
 * removed. If any of these ever goes green-with-no-violation again, the permissive reading
 * has crept back in.
 */
describe('§395.1(g)(1) look-back vs the superseded reset reading', () => {
  it('leaves 7 h of driving in the §8.2.1 worked example, not 11 h', () => {
    // 8 h SB → 4 h D → 2 h SB, measured the instant the pair closes.
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB']]);
    expect(state.driveUsedSec).toBe(4 * H);
    expect(state.driveRemainingSec).toBe(7 * H);
    expect(state.driveRemainingSec).not.toBe(11 * H);
  });

  it('the window after the pair is 16 h from the first part, not 14 h from the second', () => {
    const state = run([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB']]);
    // 13:00Z + 14 h + the excluded 2 h = 05:00Z. The reset reading would say 19:00Z + 14 h = 09:00Z.
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
    expect(state.shiftEndsAt?.toISOString()).not.toBe('2025-01-15T09:00:00.000Z');
  });

  it('raises DRIVING_11 on driving that straddles the pair', () => {
    // 8 h driven before the short half + 4 h after = 12 h. The reset reading sees only 4 h.
    const state = run([[8 * H, 'SB'], [8 * H, 'D'], [2 * H, 'SB'], [4 * H, 'D']]);
    expect(state.driveUsedSec).toBe(12 * H);
    expect(types(state)).toEqual(['DRIVING_11']);
    expect(state.violations[0].exceededBySec).toBe(1 * H);
    expect(state.driveRemainingSec).toBe(0);
  });

  it('raises SHIFT_14 on on-duty time that straddles the pair', () => {
    // 1 h driving + 11 h on duty before the short half; the window ends 05:00Z, so the 3 h of
    // driving that starts at 03:00Z runs an hour past it. The reset reading sees a fresh window.
    const state = run([[8 * H, 'SB'], [1 * H, 'D'], [11 * H, 'ON'], [2 * H, 'SB'], [3 * H, 'D']]);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-14T13:00:00.000Z');
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
    expect(types(state)).toEqual(['SHIFT_14']);
    expect(state.violations[0].exceededBySec).toBe(1 * H);
  });

  it('excludes ONLY the second qualifying part from the new window', () => {
    // The 1 h off-duty break between the halves is non-qualifying, so it stays in the window:
    // 13:00Z + 14 h + 2 h (the second part alone) = 05:00Z.
    const state = run([[8 * H, 'SB'], [1 * H, 'ON'], [1 * H, 'OFF'], [2 * H, 'D'], [2 * H, 'SB']]);
    expect(state.shiftStartedAt?.toISOString()).toBe('2025-01-14T13:00:00.000Z');
    expect(state.shiftEndsAt?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
    expect(state.driveUsedSec).toBe(2 * H);
  });

  it('never reduces driving time when a pair closes', () => {
    // Driving time is never reduced by any path: the look-back total is at least the driving
    // already done between the two halves.
    const open = run([[8 * H, 'SB'], [6 * H, 'D'], [1 * H, 'ON']]);
    const closed = run([[8 * H, 'SB'], [6 * H, 'D'], [1 * H, 'ON'], [2 * H, 'SB']]);
    expect(open.driveUsedSec).toBe(6 * H);
    expect(closed.driveUsedSec).toBe(6 * H);
    expect(closed.driveUsedSec).toBeGreaterThanOrEqual(open.driveUsedSec);
  });

  it('still allows a genuine 10 h reset to zero the driving clock', () => {
    // Guard against over-correcting: the look-back applies to PAIRS, never to a full reset.
    const state = run([[8 * H, 'SB'], [6 * H, 'D'], [10 * H, 'OFF'], [1 * H, 'D']]);
    expect(state.driveUsedSec).toBe(1 * H);
  });
});
