/** TZ §8.3 steps 1–2 — normalisation, PC/YM, segmentation, rest runs. */
import { buildSegments, effectiveStatus, findRestRuns, isRest, normalizeEvents, qualifiesAsLongPart, qualifiesAsShortPart } from './normalize';
import { ev, H, M, timeline } from '../../../../test/helpers/hos';

const NOW = new Date('2025-01-14T20:00:00Z');

describe('effectiveStatus — §8.2 rules 10/11', () => {
  it('PC while driving counts as off duty', () => expect(effectiveStatus('D', 'PC')).toBe('OFF'));
  it('PC while on duty still counts as off duty', () => expect(effectiveStatus('ON', 'PC')).toBe('OFF'));
  it('YM while driving counts as on duty', () => expect(effectiveStatus('D', 'YM')).toBe('ON'));
  it('YM while off duty still counts as on duty', () => expect(effectiveStatus('OFF', 'YM')).toBe('ON'));
  it.each(['OFF', 'SB', 'D', 'ON'] as const)('%s without a category is unchanged', (status) => {
    expect(effectiveStatus(status, 'NONE')).toBe(status);
  });
});

describe('isRest', () => {
  it.each([['OFF', true], ['SB', true], ['D', false], ['ON', false]] as const)('%s → %s', (status, expected) => {
    expect(isRest(status)).toBe(expected);
  });
});

describe('normalizeEvents', () => {
  it('keeps an empty list empty', () => expect(normalizeEvents([], NOW)).toEqual([]));

  it('drops records that are not recordStatus 1', () => {
    const events = [ev('2025-01-14T06:00:00Z', 'OFF'), { ...ev('2025-01-14T07:00:00Z', 'D'), recordStatus: 2 }];
    expect(normalizeEvents(events, NOW)).toHaveLength(1);
  });

  it('keeps records with an explicit recordStatus 1', () => {
    expect(normalizeEvents([{ ...ev('2025-01-14T06:00:00Z', 'OFF'), recordStatus: 1 }], NOW)).toHaveLength(1);
  });

  it('drops records dated after `now`', () => {
    expect(normalizeEvents([ev('2025-01-14T06:00:00Z', 'OFF'), ev('2025-01-14T21:00:00Z', 'D')], NOW)).toHaveLength(1);
  });

  it('keeps a record landing exactly on `now`', () => {
    expect(normalizeEvents([ev('2025-01-14T20:00:00Z', 'D')], NOW)).toHaveLength(1);
  });

  it('drops records with an invalid timestamp', () => {
    expect(normalizeEvents([{ at: new Date('nonsense'), status: 'D' }], NOW)).toEqual([]);
  });

  it('sorts out-of-order records', () => {
    const sorted = normalizeEvents([ev('2025-01-14T09:00:00Z', 'D'), ev('2025-01-14T06:00:00Z', 'OFF')], NOW);
    expect(sorted.map((e) => e.status)).toEqual(['OFF', 'D']);
  });

  it('breaks a tie with eventSequenceId', () => {
    const a = { ...ev('2025-01-14T06:00:00Z', 'D'), eventSequenceId: 9 };
    const b = { ...ev('2025-01-14T06:00:00Z', 'ON'), eventSequenceId: 4 };
    expect(normalizeEvents([a, b], NOW).map((e) => e.status)).toEqual(['ON', 'D']);
  });

  it('does not mutate the caller array', () => {
    const events = [ev('2025-01-14T09:00:00Z', 'D'), ev('2025-01-14T06:00:00Z', 'OFF')];
    normalizeEvents(events, NOW);
    expect(events[0].status).toBe('D');
  });

  it('handles 10 000 records', () => {
    const events = Array.from({ length: 10_000 }, (_, i) => ev(new Date(NOW.getTime() - (10_000 - i) * 60_000).toISOString(), i % 2 ? 'D' : 'ON'));
    expect(normalizeEvents(events, NOW)).toHaveLength(10_000);
  });
});

/**
 * §8.3 step 1 tie-break. `eventSequenceId` is optional on the way in: unidentified-driver
 * assignments and engine-synthesised records (annotations, malfunction-driven status changes)
 * reach the engine without one, and two such records can share an instant. A missing id sorts
 * as 0 — before any real ELD sequence number, which starts at 1 (§4.5.x) — and equal ids must
 * leave the caller's order untouched rather than producing a nondeterministic log.
 */
describe('normalizeEvents — ties when eventSequenceId is absent', () => {
  it('keeps input order for two same-instant records that both lack a sequence id', () => {
    const first = ev('2025-01-14T06:00:00Z', 'SB');
    const second = ev('2025-01-14T06:00:00Z', 'D');
    const sorted = normalizeEvents([first, second], NOW);
    expect(sorted.map((e) => e.status)).toEqual(['SB', 'D']);
    expect(normalizeEvents([second, first], NOW).map((e) => e.status)).toEqual(['D', 'SB']);
  });

  it('sorts a record with no sequence id before one with a real sequence id', () => {
    const withId = { ...ev('2025-01-14T06:00:00Z', 'ON'), eventSequenceId: 7 };
    const withoutId = ev('2025-01-14T06:00:00Z', 'OFF');
    expect(normalizeEvents([withId, withoutId], NOW).map((e) => e.status)).toEqual(['OFF', 'ON']);
  });

  it('still orders by sequence id when only the earlier record lacks one', () => {
    const withoutId = ev('2025-01-14T06:00:00Z', 'OFF');
    const withId = { ...ev('2025-01-14T06:00:00Z', 'D'), eventSequenceId: 1 };
    expect(normalizeEvents([withoutId, withId], NOW).map((e) => e.status)).toEqual(['OFF', 'D']);
  });

  it('mixes present and absent ids across several instants deterministically', () => {
    const events = [
      { ...ev('2025-01-14T08:00:00Z', 'D'), eventSequenceId: 3 },
      ev('2025-01-14T08:00:00Z', 'ON'),
      { ...ev('2025-01-14T07:00:00Z', 'SB'), eventSequenceId: 2 },
      ev('2025-01-14T07:00:00Z', 'OFF'),
    ];
    expect(normalizeEvents(events, NOW).map((e) => e.status)).toEqual(['OFF', 'SB', 'ON', 'D']);
  });
});

describe('buildSegments', () => {
  it('returns nothing for no events', () => expect(buildSegments([], NOW)).toEqual([]));

  it('runs the last segment to `now`', () => {
    const segments = buildSegments([ev('2025-01-14T18:00:00Z', 'D')], NOW);
    expect(segments).toHaveLength(1);
    expect(segments[0].durationSec).toBe(2 * H);
    expect(segments[0].end).toEqual(NOW);
  });

  it('keeps a zero-length final segment so the current status survives', () => {
    const segments = buildSegments([ev('2025-01-14T18:00:00Z', 'OFF'), ev('2025-01-14T20:00:00Z', 'D')], NOW);
    expect(segments[segments.length - 1]).toMatchObject({ effective: 'D', durationSec: 0 });
  });

  it('drops a superseded record recorded at the same instant', () => {
    const segments = buildSegments([ev('2025-01-14T18:00:00Z', 'ON'), ev('2025-01-14T18:00:00Z', 'D'), ev('2025-01-14T19:00:00Z', 'OFF')], NOW);
    expect(segments.map((s) => s.effective)).toEqual(['D', 'OFF']);
  });

  it('merges adjacent identical statuses', () => {
    const segments = buildSegments([ev('2025-01-14T17:00:00Z', 'D'), ev('2025-01-14T18:00:00Z', 'D')], NOW);
    expect(segments).toHaveLength(1);
    expect(segments[0].durationSec).toBe(3 * H);
  });

  it('does not merge across a change of special category', () => {
    const segments = buildSegments([ev('2025-01-14T17:00:00Z', 'D', 'YM'), ev('2025-01-14T18:00:00Z', 'ON')], NOW);
    expect(segments).toHaveLength(2);
  });

  it('applies PC to the effective status', () => {
    expect(buildSegments([ev('2025-01-14T18:00:00Z', 'D', 'PC')], NOW)[0]).toMatchObject({ status: 'D', effective: 'OFF', special: 'PC' });
  });

  it('applies YM to the effective status', () => {
    expect(buildSegments([ev('2025-01-14T18:00:00Z', 'D', 'YM')], NOW)[0]).toMatchObject({ status: 'D', effective: 'ON', special: 'YM' });
  });

  it('defaults a missing category to NONE', () => {
    expect(buildSegments([{ at: new Date('2025-01-14T18:00:00Z'), status: 'D' }], NOW)[0].special).toBe('NONE');
  });
});

describe('findRestRuns', () => {
  const run = (steps: Parameters<typeof timeline>[1]) => {
    const built = timeline('2025-01-14T00:00:00Z', steps);
    return findRestRuns(buildSegments(built.events, built.end));
  };

  it('finds nothing in a driving-only timeline', () => {
    expect(run([[4 * H, 'D']])).toHaveLength(0);
  });

  it('merges OFF and SB into one run', () => {
    const runs = run([[2 * H, 'OFF'], [6 * H, 'SB'], [1 * H, 'D']]);
    expect(runs).toHaveLength(1);
    expect(runs[0].durationSec).toBe(8 * H);
  });

  it('reports the longest continuous sleeper stretch inside the run', () => {
    const runs = run([[1 * H, 'SB'], [30 * M, 'OFF'], [7 * H, 'SB'], [1 * H, 'D']]);
    expect(runs[0].longestSbSec).toBe(7 * H);
    expect(runs[0].longestSbStart?.toISOString()).toBe('2025-01-14T01:30:00.000Z');
  });

  it('marks a 10-hour run as a full reset', () => {
    expect(run([[10 * H, 'OFF'], [1 * H, 'D']])[0].isFullReset).toBe(true);
  });

  it('does not mark 9:59 as a full reset', () => {
    expect(run([[10 * H - 60, 'OFF'], [1 * H, 'D']])[0].isFullReset).toBe(false);
  });

  it('splits two runs around driving', () => {
    const runs = run([[3 * H, 'OFF'], [1 * H, 'D'], [3 * H, 'SB'], [1 * H, 'D']]);
    expect(runs).toHaveLength(2);
  });

  it('does not split a run around a yard move that reads as ON', () => {
    const runs = run([[3 * H, 'OFF'], [1 * H, 'OFF', 'YM'], [3 * H, 'OFF'], [1 * H, 'D']]);
    expect(runs).toHaveLength(2);
  });

  it('treats PC as rest inside a run', () => {
    const runs = run([[3 * H, 'OFF'], [1 * H, 'D', 'PC'], [3 * H, 'OFF'], [1 * H, 'D']]);
    expect(runs).toHaveLength(1);
    expect(runs[0].durationSec).toBe(7 * H);
  });

  it('records the index of the segment that closes the run', () => {
    const runs = run([[1 * H, 'D'], [3 * H, 'OFF'], [1 * H, 'D']]);
    expect(runs[0].endIndex).toBe(1);
  });

  it('handles a timeline that is entirely rest', () => {
    const runs = run([[12 * H, 'SB']]);
    expect(runs[0]).toMatchObject({ durationSec: 12 * H, longestSbSec: 12 * H, isFullReset: true });
  });
});

describe('split part qualification thresholds', () => {
  const make = (sb: number, total: number) => ({ start: new Date(0), end: new Date(0), durationSec: total, longestSbSec: sb, longestSbStart: new Date(0), longestSbEnd: new Date(0), endIndex: 0, isFullReset: false });

  it('7:00 of sleeper qualifies as the long part', () => expect(qualifiesAsLongPart(make(7 * H, 7 * H))).toBe(true));
  it('6:59 of sleeper does not', () => expect(qualifiesAsLongPart(make(7 * H - 60, 7 * H))).toBe(false));
  it('7 h of OFF does not qualify as the long part', () => expect(qualifiesAsLongPart(make(0, 7 * H))).toBe(false));
  it('2:00 of rest qualifies as the short part', () => expect(qualifiesAsShortPart(make(0, 2 * H))).toBe(true));
  it('1:59 of rest does not', () => expect(qualifiesAsShortPart(make(0, 2 * H - 60))).toBe(false));
});
