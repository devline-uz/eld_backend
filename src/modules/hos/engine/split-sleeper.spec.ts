/** TZ §8.2.1 — split sleeper pairing, in isolation from the rest of the engine. */
import { analyzeSplits, classifyPart, partsPair, type SplitPart } from './split-sleeper';
import { buildSegments, findRestRuns, type RestRun } from './normalize';
import { H, M, timeline } from '../../../../test/helpers/hos';

const runsFor = (steps: Parameters<typeof timeline>[1]): RestRun[] => {
  const built = timeline('2025-01-14T00:00:00Z', steps);
  return findRestRuns(buildSegments(built.events, built.end));
};

const part = (kind: 'LONG' | 'SHORT', seconds: number, endIndex = 0): SplitPart => ({
  kind, start: new Date(0), end: new Date(seconds * 1000), partSec: seconds, endIndex,
});

describe('classifyPart', () => {
  it('classifies an 8 h sleeper period as the long part', () => {
    expect(classifyPart(runsFor([[8 * H, 'SB'], [1 * H, 'D']])[0])).toMatchObject({ kind: 'LONG', partSec: 8 * H });
  });

  it('classifies exactly 7 h of sleeper as the long part', () => {
    expect(classifyPart(runsFor([[7 * H, 'SB'], [1 * H, 'D']])[0])).toMatchObject({ kind: 'LONG' });
  });

  it('rejects 6:59 of sleeper as a long part and falls back to SHORT', () => {
    expect(classifyPart(runsFor([[7 * H - 60, 'SB'], [1 * H, 'D']])[0])).toMatchObject({ kind: 'SHORT' });
  });

  it('classifies 3 h off duty as the short part', () => {
    expect(classifyPart(runsFor([[3 * H, 'OFF'], [1 * H, 'D']])[0])).toMatchObject({ kind: 'SHORT', partSec: 3 * H });
  });

  it('classifies exactly 2 h as the short part', () => {
    expect(classifyPart(runsFor([[2 * H, 'OFF'], [1 * H, 'D']])[0])).toMatchObject({ kind: 'SHORT' });
  });

  it('rejects 1:59 of rest entirely', () => {
    expect(classifyPart(runsFor([[2 * H - 60, 'OFF'], [1 * H, 'D']])[0])).toBeNull();
  });

  it('rejects a 10 h rest — that is a full reset, not a split part', () => {
    expect(classifyPart(runsFor([[10 * H, 'SB'], [1 * H, 'D']])[0])).toBeNull();
  });

  it('uses only the continuous sleeper stretch for the long part, not the whole run', () => {
    const result = classifyPart(runsFor([[1 * H, 'OFF'], [7 * H, 'SB'], [1 * H, 'D']])[0]);
    expect(result).toMatchObject({ kind: 'LONG', partSec: 7 * H });
    expect(result?.start.toISOString()).toBe('2025-01-14T01:00:00.000Z');
  });

  it('does not accept off duty as a substitute for sleeper in the long part', () => {
    expect(classifyPart(runsFor([[8 * H - 60, 'OFF'], [1 * H, 'D']])[0])).toMatchObject({ kind: 'SHORT' });
  });
});

describe('partsPair', () => {
  it('pairs 8 h sleeper with 2 h off duty', () => expect(partsPair(part('LONG', 8 * H), part('SHORT', 2 * H))).toBe(true));
  it('pairs 7 h sleeper with 3 h off duty', () => expect(partsPair(part('LONG', 7 * H), part('SHORT', 3 * H))).toBe(true));
  it('pairs 7.5 h with 2.5 h', () => expect(partsPair(part('LONG', 7.5 * H), part('SHORT', 2.5 * H))).toBe(true));
  it('refuses 7 h + 2 h — only 9 h in total', () => expect(partsPair(part('LONG', 7 * H), part('SHORT', 2 * H))).toBe(false));
  it('refuses two short parts however long', () => expect(partsPair(part('SHORT', 6 * H), part('SHORT', 6 * H))).toBe(false));
  it('pairs two long parts', () => expect(partsPair(part('LONG', 7 * H), part('LONG', 7 * H))).toBe(true));
  it('pairs in either order', () => expect(partsPair(part('SHORT', 3 * H), part('LONG', 7 * H))).toBe(true));
  it('accepts exactly 10 h in total', () => expect(partsPair(part('LONG', 7 * H), part('SHORT', 3 * H))).toBe(true));
  it('refuses one second under 10 h', () => expect(partsPair(part('LONG', 7 * H), part('SHORT', 3 * H - 1))).toBe(false));
});

describe('analyzeSplits', () => {
  it('does nothing when the driver has no split-sleeper exception', () => {
    const analysis = analyzeSplits(runsFor([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]), false);
    expect(analysis.pairs).toHaveLength(0);
    expect(analysis.partsByEndIndex.size).toBe(0);
  });

  it('closes an 8/2 pair', () => {
    const analysis = analyzeSplits(runsFor([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]), true);
    expect(analysis.pairs).toHaveLength(1);
    expect(analysis.pairs[0].first.partSec).toBe(8 * H);
    expect(analysis.pairs[0].second.partSec).toBe(2 * H);
    expect(analysis.pendingPart).toBeNull();
  });

  it('closes a 7/3 pair', () => {
    expect(analyzeSplits(runsFor([[7 * H, 'SB'], [4 * H, 'D'], [3 * H, 'OFF'], [1 * H, 'D']]), true).pairs).toHaveLength(1);
  });

  it('closes a 3/7 pair when the short half comes first', () => {
    expect(analyzeSplits(runsFor([[3 * H, 'OFF'], [4 * H, 'D'], [7 * H, 'SB'], [1 * H, 'D']]), true).pairs).toHaveLength(1);
  });

  it('leaves a 7 h + 2 h sequence unpaired', () => {
    const analysis = analyzeSplits(runsFor([[7 * H, 'SB'], [4 * H, 'D'], [2 * H, 'OFF'], [1 * H, 'D']]), true);
    expect(analysis.pairs).toHaveLength(0);
    expect(analysis.pendingPart).toMatchObject({ kind: 'SHORT', partSec: 2 * H });
  });

  it('excludes an unpaired 7 h sleeper period from the window', () => {
    const analysis = analyzeSplits(runsFor([[7 * H, 'SB'], [4 * H, 'D'], [2 * H, 'OFF'], [1 * H, 'D']]), true);
    expect([...analysis.excludedWhilePendingByEndIndex.values()].map((p) => p.partSec)).toEqual([7 * H]);
  });

  it('does NOT exclude a lone 2 h off-duty break from the window', () => {
    const analysis = analyzeSplits(runsFor([[2 * H, 'OFF'], [4 * H, 'D']]), true);
    expect(analysis.excludedWhilePendingByEndIndex.size).toBe(0);
  });

  it('excludes the first half of a pair that closes later', () => {
    const analysis = analyzeSplits(runsFor([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]), true);
    expect(analysis.excludedWhilePendingByEndIndex.size).toBe(1);
    expect([...analysis.excludedWhilePendingByEndIndex.values()][0].partSec).toBe(8 * H);
  });

  it('records where the pair closes', () => {
    const analysis = analyzeSplits(runsFor([[8 * H, 'SB'], [4 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]), true);
    expect([...analysis.pairCloseByEndIndex.keys()]).toEqual([2]);
  });

  it('uses each part in exactly one pair across three consecutive parts', () => {
    const analysis = analyzeSplits(runsFor([[8 * H, 'SB'], [2 * H, 'D'], [2 * H, 'SB'], [2 * H, 'D'], [7 * H, 'SB'], [2 * H, 'D']]), true);
    expect(analysis.pairs).toHaveLength(1);
    expect(analysis.pendingPart).toMatchObject({ kind: 'LONG', partSec: 7 * H });
  });

  it('closes two pairs from four parts', () => {
    const analysis = analyzeSplits(runsFor([[8 * H, 'SB'], [2 * H, 'D'], [2 * H, 'SB'], [2 * H, 'D'], [7 * H, 'SB'], [2 * H, 'D'], [3 * H, 'OFF'], [1 * H, 'D']]), true);
    expect(analysis.pairs).toHaveLength(2);
    expect(analysis.pendingPart).toBeNull();
  });

  it('a full 10 h reset drops a half-built pair', () => {
    const analysis = analyzeSplits(runsFor([[8 * H, 'SB'], [2 * H, 'D'], [10 * H, 'OFF'], [2 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]), true);
    expect(analysis.pairs).toHaveLength(0);
    expect(analysis.pendingPart).toMatchObject({ partSec: 2 * H });
  });

  it('ignores rests that are too short to qualify at all', () => {
    const analysis = analyzeSplits(runsFor([[8 * H, 'SB'], [2 * H, 'D'], [30 * M, 'OFF'], [2 * H, 'D'], [2 * H, 'SB'], [1 * H, 'D']]), true);
    expect(analysis.pairs).toHaveLength(1);
  });

  it('returns empty structures for an empty timeline', () => {
    expect(analyzeSplits([], true)).toMatchObject({ pairs: [], pendingPart: null });
  });
});
