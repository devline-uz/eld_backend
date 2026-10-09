/** TZ §8.2 rules 4/5/6 — cycle window, 34 h restart and recap, in isolation. */
import { cycleUsedOn, mergeHistory, onDutyByDay, recapAt, resolveRestartEnd } from './cycle';
import { buildSegments, findRestRuns } from './normalize';
import { H, timeline, TZ } from '../../../../test/helpers/hos';

const build = (steps: Parameters<typeof timeline>[1], start = '2025-01-14T05:00:00Z') => {
  const built = timeline(start, steps);
  const segments = buildSegments(built.events, built.end);
  return { segments, runs: findRestRuns(segments), now: built.end };
};

describe('resolveRestartEnd', () => {
  it('finds no restart in a short timeline', () => {
    const { runs, now } = build([[10 * H, 'OFF'], [2 * H, 'D']]);
    expect(resolveRestartEnd(runs, null, now)).toBeNull();
  });

  it('finds a 34 h rest', () => {
    const { runs, now } = build([[34 * H, 'OFF'], [1 * H, 'D']]);
    expect(resolveRestartEnd(runs, null, now)?.toISOString()).toBe('2025-01-15T15:00:00.000Z');
  });

  it('rejects 33:59', () => {
    const { runs, now } = build([[34 * H - 60, 'OFF'], [1 * H, 'D']]);
    expect(resolveRestartEnd(runs, null, now)).toBeNull();
  });

  it('accepts a mix of OFF and SB', () => {
    const { runs, now } = build([[20 * H, 'OFF'], [14 * H, 'SB'], [1 * H, 'D']]);
    expect(resolveRestartEnd(runs, null, now)).not.toBeNull();
  });

  it('rejects a rest interrupted by on-duty time', () => {
    const { runs, now } = build([[20 * H, 'OFF'], [1 * H, 'ON'], [20 * H, 'OFF'], [1 * H, 'D']]);
    expect(resolveRestartEnd(runs, null, now)).toBeNull();
  });

  it('uses the caller-supplied lastRestartEndedAt', () => {
    const { runs, now } = build([[4 * H, 'OFF'], [2 * H, 'D']]);
    const supplied = new Date('2025-01-14T04:00:00Z');
    expect(resolveRestartEnd(runs, supplied, now)).toEqual(supplied);
  });

  it('ignores a lastRestartEndedAt in the future', () => {
    const { runs, now } = build([[4 * H, 'OFF'], [2 * H, 'D']]);
    expect(resolveRestartEnd(runs, new Date('2030-01-01T00:00:00Z'), now)).toBeNull();
  });

  it('prefers the later of the supplied value and the observed rest', () => {
    const { runs, now } = build([[34 * H, 'OFF'], [1 * H, 'D']]);
    expect(resolveRestartEnd(runs, new Date('2025-01-14T00:00:00Z'), now)?.toISOString()).toBe('2025-01-15T15:00:00.000Z');
  });

  it('counts the 34th hour of an in-progress rest as soon as it passes', () => {
    const { runs, now } = build([[40 * H, 'OFF']]);
    expect(resolveRestartEnd(runs, null, now)?.toISOString()).toBe('2025-01-15T15:00:00.000Z');
  });
});

/**
 * The 34 h restart is credited at the 34th hour of the run, so a run whose duration ROUNDS UP
 * to 34 h (ELD timestamps carry milliseconds) must not be credited before that instant has
 * actually arrived — crediting it early would wipe the driver's cycle hours a fraction of a
 * second too soon.
 */
describe('resolveRestartEnd — sub-second precision at the 34 h mark', () => {
  const startMs = new Date('2025-01-14T05:00:00.400Z').getTime();
  const restRuns = (nowMs: number) => {
    const segments = buildSegments([{ at: new Date(startMs), status: 'OFF', special: 'NONE' }], new Date(nowMs));
    return { runs: findRestRuns(segments), now: new Date(nowMs) };
  };

  it('rounds 33:59:59.600 up to 34 h but does not credit the restart yet', () => {
    const { runs, now } = restRuns(startMs + 34 * H * 1000 - 400);
    expect(runs[0].durationSec).toBe(34 * H);
    expect(resolveRestartEnd(runs, null, now)).toBeNull();
  });

  it('credits the restart the moment the 34th hour is genuinely reached', () => {
    const { runs, now } = restRuns(startMs + 34 * H * 1000);
    expect(resolveRestartEnd(runs, null, now)?.toISOString()).toBe('2025-01-15T15:00:00.400Z');
  });

  it('falls back to the earlier completed restart when the newest one is a rounding artefact', () => {
    const { runs, now } = build([[34 * H, 'OFF'], [4 * H, 'D'], [34 * H, 'OFF']]);
    // Last run is complete; shave the clock so its 34th hour has not arrived yet.
    const earlyNow = new Date(now.getTime() - 1000);
    const trimmed = findRestRuns(buildSegments(timeline('2025-01-14T05:00:00Z', [[34 * H, 'OFF'], [4 * H, 'D'], [34 * H - 1, 'OFF']]).events, earlyNow));
    expect(trimmed[trimmed.length - 1].durationSec).toBe(34 * H - 1);
    expect(resolveRestartEnd(trimmed, null, earlyNow)?.toISOString()).toBe('2025-01-15T15:00:00.000Z');
    expect(runs).toHaveLength(2);
  });
});

describe('onDutyByDay', () => {
  it('bills on-duty and driving to the local day', () => {
    const { segments } = build([[10 * H, 'OFF'], [2 * H, 'ON'], [3 * H, 'D']]);
    expect(onDutyByDay(segments, TZ, null).get('2025-01-14')).toBe(5 * H);
  });

  it('ignores off duty and sleeper', () => {
    const { segments } = build([[10 * H, 'OFF'], [2 * H, 'SB']]);
    expect(onDutyByDay(segments, TZ, null).size).toBe(0);
  });

  it('splits a shift across local midnight', () => {
    const { segments } = build([[10 * H, 'D']], '2025-01-14T21:00:00Z');
    const totals = onDutyByDay(segments, TZ, null);
    expect(totals.get('2025-01-14')).toBe(8 * H);
    expect(totals.get('2025-01-15')).toBe(2 * H);
  });

  it('uses the home terminal timezone for the split', () => {
    const { segments } = build([[10 * H, 'D']], '2025-01-14T21:00:00Z');
    expect(onDutyByDay(segments, 'America/Los_Angeles', null).get('2025-01-15')).toBeUndefined();
  });

  it('drops time before the restart cutoff', () => {
    const { segments } = build([[4 * H, 'ON'], [4 * H, 'D']]);
    expect(onDutyByDay(segments, TZ, new Date('2025-01-14T11:00:00Z')).get('2025-01-14')).toBe(2 * H);
  });

  it('drops a segment entirely contained before the cutoff', () => {
    const { segments } = build([[4 * H, 'ON'], [4 * H, 'D']]);
    expect(onDutyByDay(segments, TZ, new Date('2025-01-14T09:00:00Z')).get('2025-01-14')).toBe(4 * H);
  });

  it('counts a 25-hour day correctly', () => {
    const { segments } = build([[13 * H, 'ON']], '2025-11-02T04:00:00Z');
    expect(onDutyByDay(segments, TZ, null).get('2025-11-02')).toBe(13 * H);
  });
});

/**
 * Day-boundary pathologies. `dayKeysBetween` walks CALENDAR keys, so a key can exist on the
 * calendar while having no local duration at all; such a day must contribute nothing and must
 * not swallow the neighbouring days' seconds.
 */
describe('onDutyByDay — degenerate local days', () => {
  it('bills the hour before a midnight DST transition to the correct day (B-041)', () => {
    // America/Havana springs forward AT midnight on 2026-03-08: 2026-03-07 23:00 local is the
    // last hour of 03-07 and used to vanish from the cycle entirely.
    const segments = buildSegments([{ at: new Date('2026-03-08T04:00:00Z'), status: 'ON', special: 'NONE' }], new Date('2026-03-08T05:00:00Z'));
    const totals = onDutyByDay(segments, 'America/Havana', null);
    expect(totals.get('2026-03-07')).toBe(H);
    expect(totals.get('2026-03-08')).toBeUndefined();
  });

  it('attributes nothing to a calendar date the zone skipped, without losing seconds', () => {
    // Pacific/Apia jumped from 2011-12-29 to 2011-12-31; the key 2011-12-30 has zero length.
    const segments = buildSegments([{ at: new Date('2011-12-29T20:00:00Z'), status: 'D', special: 'NONE' }], new Date('2011-12-30T14:00:00Z'));
    const totals = onDutyByDay(segments, 'Pacific/Apia', null);
    expect(totals.get('2011-12-30')).toBeUndefined();
    expect(totals.get('2011-12-29')).toBe(14 * H);
    expect(totals.get('2011-12-31')).toBe(4 * H);
    expect([...totals.values()].reduce((a, b) => a + b, 0)).toBe(18 * H);
  });
});

describe('mergeHistory', () => {
  it('keeps history for days with no events', () => {
    const totals = mergeHistory([{ date: '2025-01-13', onDutySec: 5 * H }], new Map(), null);
    expect(totals.get('2025-01-13')).toBe(5 * H);
  });

  it('prefers the larger of history and derived totals', () => {
    const totals = mergeHistory([{ date: '2025-01-14', onDutySec: 2 * H }], new Map([['2025-01-14', 6 * H]]), null);
    expect(totals.get('2025-01-14')).toBe(6 * H);
  });

  it('drops history from before the restart day', () => {
    const totals = mergeHistory([{ date: '2025-01-10', onDutySec: 60 * H }], new Map(), '2025-01-12');
    expect(totals.size).toBe(0);
  });

  it('keeps history on the restart day itself', () => {
    const totals = mergeHistory([{ date: '2025-01-12', onDutySec: 3 * H }], new Map(), '2025-01-12');
    expect(totals.get('2025-01-12')).toBe(3 * H);
  });

  it('clamps a negative history value to zero', () => {
    expect(mergeHistory([{ date: '2025-01-13', onDutySec: -10 }], new Map(), null).get('2025-01-13')).toBe(0);
  });

  it('handles an empty history', () => {
    expect(mergeHistory([], new Map([['2025-01-14', H]]), null).get('2025-01-14')).toBe(H);
  });
});

describe('cycleUsedOn', () => {
  const totals = new Map(Array.from({ length: 10 }, (_, i) => [`2025-01-${String(i + 5).padStart(2, '0')}`, 5 * H]));

  it('sums an 8-day window', () => expect(cycleUsedOn(totals, '2025-01-14', 8, null)).toBe(40 * H));
  it('sums a 7-day window', () => expect(cycleUsedOn(totals, '2025-01-14', 7, null)).toBe(35 * H));
  it('excludes the 9th day back', () => expect(cycleUsedOn(totals, '2025-01-12', 8, null)).toBe(8 * 5 * H));
  it('returns zero for an empty map', () => expect(cycleUsedOn(new Map(), '2025-01-14', 8, null)).toBe(0));
  it('ignores days before a restart', () => expect(cycleUsedOn(totals, '2025-01-14', 8, '2025-01-13')).toBe(10 * H));
  it('counts nothing when the restart is today', () => expect(cycleUsedOn(totals, '2025-01-14', 8, '2025-01-14')).toBe(5 * H));
});

describe('recapAt', () => {
  const now = new Date('2025-01-14T18:00:00Z');

  it('returns the next local midnight when hours come back', () => {
    const totals = new Map([['2025-01-07', 6 * H]]);
    expect(recapAt(totals, TZ, now, 8)?.toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });

  it('skips an empty dropping day and reports the first later midnight that returns hours', () => {
    // 2025-01-08 leaves the 8-day window at the end of 2025-01-15.
    expect(recapAt(new Map([['2025-01-08', 6 * H]]), TZ, now, 8)?.toISOString()).toBe('2025-01-16T05:00:00.000Z');
  });

  it('treats a zero-hour day as nothing to recap', () => {
    const totals = new Map([['2025-01-07', 0], ['2025-01-09', 5 * H]]);
    expect(recapAt(totals, TZ, now, 8)?.toISOString()).toBe('2025-01-17T05:00:00.000Z');
  });

  it("reports today's hours leaving after the whole window", () => {
    expect(recapAt(new Map([['2025-01-14', 1 * H]]), TZ, now, 8)?.toISOString()).toBe('2025-01-22T05:00:00.000Z');
  });

  it('ignores days before the restart day', () => {
    const totals = new Map([['2025-01-07', 9 * H], ['2025-01-12', 2 * H]]);
    expect(recapAt(totals, TZ, now, 8, '2025-01-10')?.toISOString()).toBe('2025-01-20T05:00:00.000Z');
  });

  it('returns null when every day of the window is empty', () => {
    expect(recapAt(new Map([['2025-01-06', 9 * H], ['2025-01-10', 0]]), TZ, now, 8)).toBeNull();
  });

  it('uses the 7-day window for 60/7', () => {
    expect(recapAt(new Map([['2025-01-08', 6 * H]]), TZ, now, 7)).not.toBeNull();
  });

  it('returns null for an empty history', () => {
    expect(recapAt(new Map(), TZ, now, 8)).toBeNull();
  });

  it('follows the home terminal timezone', () => {
    const totals = new Map([['2025-01-07', 6 * H]]);
    expect(recapAt(totals, 'America/Los_Angeles', now, 8)?.toISOString()).toBe('2025-01-15T08:00:00.000Z');
  });
});
