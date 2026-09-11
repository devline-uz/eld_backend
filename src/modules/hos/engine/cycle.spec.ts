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

  it('returns null when the dropping day is empty', () => {
    expect(recapAt(new Map([['2025-01-08', 6 * H]]), TZ, now, 8)).toBeNull();
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
