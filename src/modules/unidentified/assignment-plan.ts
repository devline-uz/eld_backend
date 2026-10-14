/**
 * CODE-007 — what attributing an unidentified-driving segment does to the driver's OWN timeline.
 *
 * The pool records only describe `[startAt, endAt]`. Appended to the driver's log without a
 * closing record, the segment's last status (DRIVING / ON-DUTY) ran on until the driver's next
 * own record — a fully off-duty day became "Driving 2 h + On-duty 12 h". Two rules fix that:
 *
 *   1. RESTORE — at `endAt` the driver goes back to the duty status their own log had in force
 *      there (OFF when they have no record at all, §395.8(a)). Skipped only when the driver has
 *      an own duty-status record exactly at `endAt`: that record already takes over, and a later
 *      restore at the same instant would override it (later `eventSequenceId` wins).
 *   2. NO OVERLAP — a driver cannot have driven this unit while their own log says something
 *      else happened: an own duty-status / PC-YM record inside `[startAt, endAt)`, DRIVING in
 *      force at `startAt`, or a PC / YM category in force at `startAt` (the driver was already
 *      moving a CMV) refuses the assignment. The log must be corrected first (§395.30 edit).
 *
 * Pure on purpose (no Prisma, no Nest), like `logs/rods.ts`, whose supersede-aware timeline
 * (`activeRecords`, D-019) it reads — the same view the RODS log and the HOS engine use.
 */
import type { DutyStatus } from '../hos/hos.types';
import { activeRecords, specialInEffectAt, statusInEffectAt, type RodsEvent } from '../logs/rods';

const DUTY_STATUS = 1;
const PC_YM = 3;

export type AssignmentConflictReason = 'OWN_RECORDS_INSIDE' | 'DRIVING_AT_START' | 'SPECIAL_AT_START';

export interface AssignmentConflict {
  reason: AssignmentConflictReason;
  /** The driver's own records inside the segment (OWN_RECORDS_INSIDE), ascending. */
  conflictingAt: Date[];
}

export interface AssignmentPlan {
  conflict: AssignmentConflict | null;
  /** Status the RESTORE record re-states at `endAt`; null when no RESTORE must be written. */
  restoreStatus: DutyStatus | null;
}

/**
 * @param ownEvents the driver's records (every record status) from a lookback before `startAt`
 *                  through `endAt` inclusive — never the pool records being assigned.
 */
export function planAssignmentAgainstDriverLog(
  ownEvents: RodsEvent[],
  segment: { startAt: Date; endAt: Date },
): AssignmentPlan {
  const start = segment.startAt.getTime();
  const end = segment.endAt.getTime();
  const timeline = activeRecords(ownEvents).filter(
    (event) => event.eventType === DUTY_STATUS || event.eventType === PC_YM,
  );

  const inside = timeline
    .filter((event) => event.eventDateTime.getTime() >= start && event.eventDateTime.getTime() < end)
    .map((event) => event.eventDateTime)
    .sort((a, b) => a.getTime() - b.getTime());

  let conflict: AssignmentConflict | null = null;
  if (inside.length > 0) {
    conflict = { reason: 'OWN_RECORDS_INSIDE', conflictingAt: inside };
  } else if (statusInEffectAt(ownEvents, segment.startAt) === 'D') {
    conflict = { reason: 'DRIVING_AT_START', conflictingAt: [] };
  } else if (specialInEffectAt(ownEvents, segment.startAt) !== 'NONE') {
    conflict = { reason: 'SPECIAL_AT_START', conflictingAt: [] };
  }

  const ownRecordAtEnd = timeline.some(
    (event) => event.eventType === DUTY_STATUS && event.eventDateTime.getTime() === end,
  );
  const restoreStatus = ownRecordAtEnd ? null : (statusInEffectAt(ownEvents, segment.endAt) ?? 'OFF');

  return { conflict, restoreStatus };
}
