/**
 * TZ §8.3 steps 1–2 — normalisation and segmentation.
 *
 * Input events are duty-status records (instants). The engine works on SEGMENTS: the interval
 * between one record and the next, and from the last record to `now`. Nothing else in the
 * engine is allowed to look at raw events.
 */
import type { DutyStatus, NormalizedEvent, SpecialDrivingCategory } from '../hos.types';
import { PROPERTY_SPLIT, RESET_REST, type SplitRule } from './limits';

export interface Segment {
  start: Date;
  end: Date;
  durationSec: number;
  /** The status as recorded. */
  status: DutyStatus;
  /** §8.2 rules 10/11 applied: PC ⇒ OFF, YM ⇒ ON. This is what every rule counts. */
  effective: DutyStatus;
  special: SpecialDrivingCategory;
}

/** A maximal run of consecutive OFF/SB segments — the unit of rest analysis (§8.2.1). */
export interface RestRun {
  start: Date;
  end: Date;
  durationSec: number;
  /** Longest continuous SLEEPER-BERTH-only stretch inside the run. */
  longestSbSec: number;
  longestSbStart: Date | null;
  longestSbEnd: Date | null;
  /** Index of the segment that closes the run (segments[endIndex]). */
  endIndex: number;
  /** A continuous OFF/SB run of at least the reset threshold (10 h property, 8 h passenger) — never a split part. */
  isFullReset: boolean;
}

/**
 * Which special driving categories the driver is authorised to use (`Driver.allowPersonalConveyance`
 * / `allowYardMove`). `computeHos` passes the driver's flags (absent ⇒ false, B-131); other callers
 * that only draw the recorded statuses (the RODS graph) keep the default "authorised".
 */
export interface SpecialCategoryPermissions {
  allowPc: boolean;
  allowYm: boolean;
}

const ALL_SPECIAL_CATEGORIES: SpecialCategoryPermissions = { allowPc: true, allowYm: true };

/**
 * §8.2 rules 10/11 — authorised PC is off-duty, authorised YM is on-duty; neither is ever driving
 * time. An UNAUTHORISED category changes nothing: the recorded status stands, so driving recorded
 * under a PC/YM tag the driver may not use is still driving time (never reduced by any path).
 */
export function effectiveStatus(
  status: DutyStatus,
  special: SpecialDrivingCategory,
  permissions: SpecialCategoryPermissions = ALL_SPECIAL_CATEGORIES,
): DutyStatus {
  if (special === 'PC' && permissions.allowPc) return 'OFF';
  if (special === 'YM' && permissions.allowYm) return 'ON';
  return status;
}

export function isRest(status: DutyStatus): boolean {
  return status === 'OFF' || status === 'SB';
}

/**
 * `recordStatus = 1` only, chronological, ties broken by `eventSequenceId`, everything
 * strictly after `now` dropped (a future-dated record cannot describe elapsed time).
 */
export function normalizeEvents(events: NormalizedEvent[], now: Date): NormalizedEvent[] {
  const nowMs = now.getTime();
  return events
    .filter((e) => (e.recordStatus ?? 1) === 1)
    .filter((e) => e.at instanceof Date && Number.isFinite(e.at.getTime()))
    .filter((e) => e.at.getTime() <= nowMs)
    .slice()
    .sort((a, b) => {
      const byTime = a.at.getTime() - b.at.getTime();
      if (byTime !== 0) return byTime;
      return (a.eventSequenceId ?? 0) - (b.eventSequenceId ?? 0);
    });
}

/**
 * Segments from consecutive records, the last one running to `now`. Zero-length segments
 * (two records at the same instant — a correction supersedes the previous status) are
 * dropped: only the last record at an instant describes the time that follows it.
 */
export function buildSegments(
  events: NormalizedEvent[],
  now: Date,
  permissions: SpecialCategoryPermissions = ALL_SPECIAL_CATEGORIES,
): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const start = event.at;
    const end = i + 1 < events.length ? events[i + 1].at : now;
    const durationSec = Math.round((end.getTime() - start.getTime()) / 1000);
    // The record that lands exactly on `now` still describes the driver's CURRENT status and
    // starts their shift, so the final segment is kept even at zero length.
    if (durationSec <= 0 && i !== events.length - 1) continue;
    const special = event.special ?? 'NONE';
    segments.push({
      start,
      end,
      durationSec,
      status: event.status,
      effective: effectiveStatus(event.status, special, permissions),
      special,
    });
  }
  return mergeAdjacent(segments);
}

/** Consecutive segments with the same effective status and category are one segment. */
function mergeAdjacent(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.effective === segment.effective && last.special === segment.special && last.end.getTime() === segment.start.getTime()) {
      last.end = segment.end;
      last.durationSec += segment.durationSec;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

/**
 * Maximal OFF/SB runs, with the longest continuous sleeper-berth stretch inside each. `resetSec`
 * is the ruleset's full-reset threshold: 10 h property (§395.3(a)(1)), 8 h passenger (§395.5(a)).
 */
export function findRestRuns(segments: Segment[], resetSec: number = RESET_REST): RestRun[] {
  const runs: RestRun[] = [];
  let index = 0;
  while (index < segments.length) {
    if (!isRest(segments[index].effective)) {
      index += 1;
      continue;
    }
    const startIndex = index;
    let endIndex = index;
    while (endIndex + 1 < segments.length && isRest(segments[endIndex + 1].effective)) endIndex += 1;

    let longestSbSec = 0;
    let longestSbStart: Date | null = null;
    let longestSbEnd: Date | null = null;
    let sbSec = 0;
    let sbStart: Date | null = null;
    for (let i = startIndex; i <= endIndex; i += 1) {
      const segment = segments[i];
      if (segment.effective === 'SB') {
        if (sbStart === null) sbStart = segment.start;
        sbSec += segment.durationSec;
        if (sbSec > longestSbSec) {
          longestSbSec = sbSec;
          longestSbStart = sbStart;
          longestSbEnd = segment.end;
        }
      } else {
        sbSec = 0;
        sbStart = null;
      }
    }

    const start = segments[startIndex].start;
    const end = segments[endIndex].end;
    const durationSec = Math.round((end.getTime() - start.getTime()) / 1000);
    runs.push({
      start,
      end,
      durationSec,
      longestSbSec,
      longestSbStart,
      longestSbEnd,
      endIndex,
      isFullReset: durationSec >= resetSec,
    });
    index = endIndex + 1;
  }
  return runs;
}

/** True when the run can serve as the LONGER half of a split pair (§8.2.1; passenger: any ≥ 2 h SB part). */
export function qualifiesAsLongPart(run: RestRun, rule: SplitRule = PROPERTY_SPLIT): boolean {
  return run.longestSbSec >= rule.longMinSec;
}

/** True when the run can serve as the SHORTER half of a split pair (property: SB **or** OFF; passenger: never). */
export function qualifiesAsShortPart(run: RestRun, rule: SplitRule = PROPERTY_SPLIT): boolean {
  return rule.shortMayBeOffDuty && run.durationSec >= rule.shortMinSec;
}
