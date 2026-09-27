/**
 * 49 CFR §395.30(c)(2) + TZ §9.1/§9.3 — driving time is immutable.
 *
 * "A motor carrier may request edits ... but the ELD must not allow the driving time to be
 * reduced or reassigned to another duty status." That binds BOTH directions: the carrier's
 * edit request AND the driver's own correction. Everything in this file is pure so the rule
 * can be tested without a database and reused by any caller that writes §395 records.
 */
import type { DutyStatus } from '../hos/hos.types';

export const DRIVING_EVENT_TYPE = 1;
export const DRIVING_EVENT_CODE = 3;

/** Reason an edit is refused with `422 DRIVING_TIME_IMMUTABLE`. */
export type DrivingImmutabilityReason =
  | 'RESTATUS_DRIVING'
  | 'SHORTEN_DRIVING'
  | 'DELETE_DRIVING'
  | 'OVERLAPS_DRIVING'
  | 'MANUAL_DRIVING'
  | 'EXTENDS_DRIVING';

export interface Interval {
  startAt: Date;
  endAt: Date;
  /**
   * The segment is still in force: its `endAt` is the caller's `now`, not a recorded record
   * (`rods.ts drivingIntervals`). Only meaningful for driving intervals (decisions.md D-089).
   */
  open?: boolean;
}

/**
 * decisions.md D-089 — how far before the server's `now` a live duty-status tap may start and
 * still count as "ending driving at the present" rather than a back-dated edit of driving time.
 * Covers network latency and the app's PT30/server-offset clock; anything older is an edit.
 */
export const LIVE_STATUS_TOLERANCE_MS = 2 * 60 * 1000;

export interface TargetEvent {
  eventType: number;
  eventCode: number;
  eventDateTime: Date;
  /** End of the interval the record owns — the next active record, or `now`. */
  intervalEndAt: Date;
  /**
   * Status in force immediately before the record (what a NEUTRALIZE row would re-state over
   * `[eventDateTime, proposedStart)` when the record is moved later). Optional: only
   * `checkDriverSelfEdit` needs it (bugs.md B-049).
   */
  statusBefore?: DutyStatus | null;
}

export interface EditProposal {
  proposedStatus: DutyStatus;
  proposedStart: Date;
  proposedEnd?: Date | null;
}

export function isDrivingRecord(event: { eventType: number; eventCode: number }): boolean {
  return event.eventType === DRIVING_EVENT_TYPE && event.eventCode === DRIVING_EVENT_CODE;
}

/** Do `[aStart, aEnd)` and `[bStart, bEnd)` share more than a boundary instant? */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

/**
 * §395.30 — a carrier edit request against an existing record.
 *
 * Allowed on a driving record: annotation only (same status, same boundaries, or an EXTENSION
 * of the driving interval). Anything that restatuses it, starts it later or ends it earlier is
 * a reduction of driving time and is refused. A non-driving record may not be moved on top of
 * driving time either — that would consume driving time indirectly.
 */
export function checkEditProposal(
  target: TargetEvent,
  proposal: EditProposal,
  drivingIntervals: Interval[] = [],
): DrivingImmutabilityReason | null {
  if (isDrivingRecord(target)) {
    if (proposal.proposedStatus !== 'D') return 'RESTATUS_DRIVING';
    if (proposal.proposedStart.getTime() > target.eventDateTime.getTime()) return 'SHORTEN_DRIVING';
    if (proposal.proposedEnd && proposal.proposedEnd.getTime() < target.intervalEndAt.getTime()) {
      return 'SHORTEN_DRIVING';
    }
    return null;
  }

  const proposed: Interval = {
    startAt: proposal.proposedStart,
    endAt: proposal.proposedEnd ?? target.intervalEndAt,
  };
  // Any overlap with an active driving interval is refused, including one the record already
  // touched: re-writing a non-driving record over driving time reduces driving time just the
  // same, and §395.30(c)(2) has no "it was already like that" exception.
  for (const driving of drivingIntervals) {
    if (overlaps(proposed, driving)) return 'OVERLAPS_DRIVING';
  }
  return null;
}

export interface SelfEditProposal {
  status: DutyStatus;
  startAt: Date;
  endAt?: Date | null;
}

/**
 * TZ §9.3 — the driver's own correction. The driver may move between OFF / SB / ON and may add
 * a missing OFF/SB/ON interval; they may never create, shorten, delete or restatus driving
 * time. A manual `D` entry is refused too: driving is recorded by the ELD from the ECM, never
 * typed in (§395.26(b)).
 */
export function checkDriverSelfEdit(
  proposal: SelfEditProposal,
  drivingIntervals: Interval[],
  target?: TargetEvent,
  now?: Date,
): DrivingImmutabilityReason | null {
  if (proposal.status === 'D') return 'MANUAL_DRIVING';
  if (target && isDrivingRecord(target)) return 'RESTATUS_DRIVING';
  // bugs.md B-049 — moving the record that FOLLOWS driving later would leave the gap
  // `[original, proposed start)` on the status that preceded it, i.e. driving. §395.26(b):
  // driving time is ELD-recorded only; a driver edit may never add or extend it. The driver
  // can still insert an OFF/SB/ON interval starting at the original instant instead.
  if (target?.statusBefore === 'D' && proposal.startAt.getTime() > target.eventDateTime.getTime()) {
    return 'EXTENDS_DRIVING';
  }

  const startMs = proposal.startAt.getTime();
  const endMs = proposal.endAt ? proposal.endAt.getTime() : startMs;
  if (endMs <= startMs) {
    // bugs.md B-073 — an open-ended entry runs until the NEXT record. Starting inside a driving
    // segment it re-states that segment's tail as OFF/SB/ON, i.e. shortens driving time.
    // Starting at or after a segment's end, or before its start, it cannot reach driving: the
    // ELD's D record is the next record and still wins from its own instant on.
    for (const driving of drivingIntervals) {
      if (startMs < driving.startAt.getTime() || startMs >= driving.endAt.getTime()) continue;
      if (isLiveStatusChange(driving, proposal.startAt, target, now)) continue;
      return 'OVERLAPS_DRIVING';
    }
    return null;
  }
  const proposed: Interval = { startAt: proposal.startAt, endAt: new Date(endMs) };
  for (const driving of drivingIntervals) {
    if (overlaps(proposed, driving)) return 'OVERLAPS_DRIVING';
  }
  return null;
}

/**
 * decisions.md D-089 — the one open entry allowed inside driving: a status change made NOW that
 * ends a driving segment the ELD has not closed yet (Appendix A 4.3.1.2 "enter the proper duty
 * status" after 5 min stationary; §395.24 duty-status entry). The part of the open segment after
 * `startAt` is only the segment projected to `now`, never recorded driving, so nothing recorded
 * is shortened. Fails closed: no `now`, a closed segment, a correction of an existing record, or
 * a start older than `LIVE_STATUS_TOLERANCE_MS` is an edit and refused.
 */
function isLiveStatusChange(driving: Interval, startAt: Date, target: TargetEvent | undefined, now?: Date): boolean {
  if (!driving.open || !now || target) return false;
  return now.getTime() - startAt.getTime() <= LIVE_STATUS_TOLERANCE_MS;
}

/** Human-readable detail for the `422 DRIVING_TIME_IMMUTABLE` envelope. */
export const IMMUTABILITY_DETAIL: Record<DrivingImmutabilityReason, string> = {
  RESTATUS_DRIVING: 'Driving time cannot be reassigned to another duty status (49 CFR §395.30(c)(2)).',
  SHORTEN_DRIVING: 'Driving time cannot be shortened (49 CFR §395.30(c)(2)).',
  DELETE_DRIVING: 'A driving record cannot be deleted (49 CFR §395.30(c)(2)).',
  OVERLAPS_DRIVING: 'The proposed interval would overwrite recorded driving time (49 CFR §395.30(c)(2)).',
  MANUAL_DRIVING: 'Driving time is recorded automatically and cannot be entered manually (49 CFR §395.26(b)).',
  EXTENDS_DRIVING:
    'Moving this record later would extend the preceding driving time; driving time is recorded automatically and cannot be added by a driver edit (49 CFR §395.26(b), §395.30). Insert an OFF/SB/ON interval starting at the original time instead.',
};
