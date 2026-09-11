/**
 * TZ §8.2.1 — split sleeper berth, the single most error-prone rule in the engine.
 *
 * Qualification (49 CFR §395.1(g)(1), as amended effective 2020-09-29):
 *   longer part  — ≥ 7 h CONTINUOUS sleeper berth (SB only, OFF does not count)
 *   shorter part — ≥ 2 h CONTINUOUS sleeper berth OR off duty
 *   the two parts together — ≥ 10 h
 *
 * Window effect — the mistake this file exists to prevent:
 *   BOTH qualifying parts are excluded from the 14-hour window. Not only the longer one.
 *   Excluding only the longer part (the pre-2020 rule) writes a phantom SHIFT_14 violation
 *   against every driver who splits their rest.
 *
 * When the pair CLOSES (the second qualifying part ends) the engine does NOT start from zero:
 * §395.1(g)(1) requires a LOOK-BACK to the end of the FIRST qualifying part, counting the
 * driving done between the two and excluding the second part from the window. That arithmetic
 * lives in `compute-hos.ts` (`applySplitLookBack`); this file only identifies the parts and
 * pairs them. Before a pair closes, the first part is excluded from the window (the window
 * stretches by its length) while driving time keeps accumulating. Each part belongs to
 * exactly one pair.
 */
import { SPLIT_PAIR_MIN } from './limits';
import { qualifiesAsLongPart, qualifiesAsShortPart, type RestRun } from './normalize';

export type SplitPartKind = 'LONG' | 'SHORT';

export interface SplitPart {
  kind: SplitPartKind;
  /** The qualifying period itself: the continuous SB stretch for LONG, the whole rest run for SHORT. */
  start: Date;
  end: Date;
  /** Seconds that count towards the ≥ 10 h pair total and are excluded from the window. */
  partSec: number;
  /** Index into `segments` of the segment that closes the underlying rest run. */
  endIndex: number;
}

export interface SplitPair {
  first: SplitPart;
  second: SplitPart;
}

export interface SplitAnalysis {
  /** Closed pairs, in chronological order. */
  pairs: SplitPair[];
  /** A qualifying part with no partner yet — its time is excluded, but nothing resets. */
  pendingPart: SplitPart | null;
  /** Every qualifying part, paired or not, keyed by the rest-run segment index that ends it. */
  partsByEndIndex: Map<number, SplitPart>;
  /** Rest-run segment index → the pair that closes there. */
  pairCloseByEndIndex: Map<number, SplitPair>;
  /**
   * Parts whose time is excluded from the running 14-hour window BEFORE their pair closes:
   * the opening half of a pair that does complete, plus a ≥ 7 h sleeper period still waiting
   * for a partner. A lone ≥ 2 h off-duty break is NOT here — short rest on its own has never
   * paused the window, and treating it as if it did would hide real SHIFT_14 violations.
   */
  excludedWhilePendingByEndIndex: Map<number, SplitPart>;
}

/** Classifies one rest run as a split-sleeper part, or `null` if it does not qualify. */
export function classifyPart(run: RestRun): SplitPart | null {
  // A ≥ 10 h continuous rest is a full reset in its own right and is never a split part.
  if (run.isFullReset) return null;
  if (qualifiesAsLongPart(run) && run.longestSbStart && run.longestSbEnd) {
    return { kind: 'LONG', start: run.longestSbStart, end: run.longestSbEnd, partSec: run.longestSbSec, endIndex: run.endIndex };
  }
  if (qualifiesAsShortPart(run)) {
    return { kind: 'SHORT', start: run.start, end: run.end, partSec: run.durationSec, endIndex: run.endIndex };
  }
  return null;
}

/** A pair needs one ≥ 7 h SB part and ≥ 10 h in total; order of the halves does not matter. */
export function partsPair(a: SplitPart, b: SplitPart): boolean {
  const hasLong = a.kind === 'LONG' || b.kind === 'LONG';
  return hasLong && a.partSec + b.partSec >= SPLIT_PAIR_MIN;
}

/**
 * Greedy nearest-pair matching (§8.2.1 step 3): each part is consumed by at most one pair, so
 * with three consecutive qualifying parts the first two pair up and the third is carried
 * forward as the opening half of the next pair.
 */
export function analyzeSplits(runs: RestRun[], enabled: boolean): SplitAnalysis {
  const analysis: SplitAnalysis = {
    pairs: [],
    pendingPart: null,
    partsByEndIndex: new Map(),
    pairCloseByEndIndex: new Map(),
    excludedWhilePendingByEndIndex: new Map(),
  };
  if (!enabled) return analysis;

  let pending: SplitPart | null = null;
  for (const run of runs) {
    if (run.isFullReset) {
      // A full 10 h reset supersedes everything; a half-built pair does not survive it.
      pending = null;
      continue;
    }
    const part = classifyPart(run);
    if (!part) continue;
    analysis.partsByEndIndex.set(part.endIndex, part);
    // A ≥ 7 h sleeper period is excluded from the window on its own, whether or not it ever
    // finds a partner; a shorter rest is excluded only once its pair actually closes.
    if (part.kind === 'LONG') analysis.excludedWhilePendingByEndIndex.set(part.endIndex, part);
    if (pending && partsPair(pending, part)) {
      const pair: SplitPair = { first: pending, second: part };
      analysis.pairs.push(pair);
      analysis.pairCloseByEndIndex.set(part.endIndex, pair);
      analysis.excludedWhilePendingByEndIndex.set(pending.endIndex, pending);
      pending = null;
      continue;
    }
    pending = part;
  }
  analysis.pendingPart = pending;
  return analysis;
}
