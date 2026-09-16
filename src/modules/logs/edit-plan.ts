/**
 * TZ §9.1 / §9.3 on an APPEND-ONLY ledger (decisions.md D-019).
 *
 * §395.30 and Appendix A describe an edit as "the original record's status becomes
 * Inactive — Changed and a new active record is added". `EldEvent` has `UPDATE` and `DELETE`
 * revoked at the database level for the application role (§5.5, §18, §23) and the role is not
 * a superuser, so the status transition cannot be an UPDATE. Every transition is therefore
 * expressed by APPENDING records:
 *
 *   INACTIVE_MARKER  recordStatus = 2, supersedesId = <original>   the "Inactive — Changed" row
 *   NEUTRALIZE       recordStatus = 1, at the original instant     re-states the status that was
 *                                                                 in force before the original,
 *                                                                 so the active timeline no
 *                                                                 longer contains the old change
 *   NEW_ACTIVE       recordStatus = 1, at the proposed instant     the corrected record
 *   RESTORE          recordStatus = 1, at the proposed end         puts the driver back on the
 *                                                                 status that followed
 *   REQUEST          recordStatus = 3, recordOrigin = 3            a carrier proposal, inert
 *   REJECT_MARKER    recordStatus = 4, supersedesId = <request>    the driver said no
 *
 * The NEUTRALIZE record is what lets every existing reader — the HOS engine included — keep
 * its simple `recordStatus = 1` filter and still see the corrected timeline: two records at the
 * same instant are resolved by `eventSequenceId`, later wins (`hos/engine/normalize.ts`).
 */
import { DUTY_CODE_BY_STATUS } from './rods';
import type { DutyStatus } from '../hos/hos.types';

export type AppendKind =
  | 'REQUEST'
  | 'INACTIVE_MARKER'
  | 'NEUTRALIZE'
  | 'NEW_ACTIVE'
  | 'RESTORE'
  | 'REJECT_MARKER';

export interface AppendRow {
  kind: AppendKind;
  eventType: number;
  eventCode: number;
  at: Date;
  recordStatus: number;
  recordOrigin: number;
  supersedesId: bigint | null;
  annotation: string;
}

export interface EditTarget {
  id: bigint;
  eventType: number;
  eventCode: number;
  eventDateTime: Date;
}

export interface ProposalInput {
  status: DutyStatus;
  startAt: Date;
  endAt?: Date | null;
  annotation: string;
  /** Status in force immediately before the original record — the NEUTRALIZE payload. */
  statusBeforeTarget?: DutyStatus | null;
  /** Status that must be back in force at `endAt`. */
  statusAfterInterval?: DutyStatus | null;
}

const DUTY = 1;

/**
 * bugs.md B-048 — the NEUTRALIZE record fills the gap `[original instant, proposed start)` with
 * the status that preceded the original. That gap only exists when the proposal starts LATER.
 * When it starts EARLIER there is no gap: the proposal already covers the original instant, and
 * a neutraliser there would cut the corrected interval short — for an accepted "driving began
 * earlier" request it re-stated the prior status over the whole driving interval, i.e. it
 * REDUCED driving time (49 CFR §395.30(c)(2)).
 */
function needsNeutralizer(target: EditTarget, proposal: ProposalInput): boolean {
  return Boolean(proposal.statusBeforeTarget) && proposal.startAt.getTime() > target.eventDateTime.getTime();
}

/** §9.1 step 2 — the carrier's proposal. Inert until the driver accepts (recordStatus = 3). */
export function planEditRequest(target: EditTarget, proposal: ProposalInput): AppendRow[] {
  return [
    {
      kind: 'REQUEST',
      eventType: DUTY,
      eventCode: DUTY_CODE_BY_STATUS[proposal.status],
      at: proposal.startAt,
      recordStatus: 3,
      recordOrigin: 3,
      supersedesId: target.id,
      annotation: proposal.annotation,
    },
  ];
}

/** §9.1 step 3 — driver accepted: old record 2, proposal becomes the active record. */
export function planAcceptEdit(
  request: EditTarget,
  target: EditTarget,
  proposal: ProposalInput,
): AppendRow[] {
  const rows: AppendRow[] = [
    {
      kind: 'INACTIVE_MARKER',
      eventType: target.eventType,
      eventCode: target.eventCode,
      at: target.eventDateTime,
      recordStatus: 2,
      recordOrigin: 3,
      supersedesId: target.id,
      annotation: proposal.annotation,
    },
  ];

  if (needsNeutralizer(target, proposal)) {
    rows.push({
      kind: 'NEUTRALIZE',
      eventType: DUTY,
      eventCode: DUTY_CODE_BY_STATUS[proposal.statusBeforeTarget as DutyStatus],
      at: target.eventDateTime,
      recordStatus: 1,
      recordOrigin: 3,
      supersedesId: target.id,
      annotation: proposal.annotation,
    });
  }

  rows.push({
    kind: 'NEW_ACTIVE',
    eventType: DUTY,
    eventCode: DUTY_CODE_BY_STATUS[proposal.status],
    at: proposal.startAt,
    recordStatus: 1,
    // §5.5 — the record was entered by another authorised user; acceptance does not make it
    // driver-entered. Appendix A keeps origin 3 for a carrier edit the driver approved.
    recordOrigin: 3,
    supersedesId: request.id,
    annotation: proposal.annotation,
  });

  if (proposal.endAt && proposal.statusAfterInterval) {
    rows.push({
      kind: 'RESTORE',
      eventType: DUTY,
      eventCode: DUTY_CODE_BY_STATUS[proposal.statusAfterInterval],
      at: proposal.endAt,
      recordStatus: 1,
      recordOrigin: 3,
      supersedesId: null,
      annotation: proposal.annotation,
    });
  }

  return rows;
}

/** §9.1 step 3 — driver rejected: the request is closed with status 4, nothing else changes. */
export function planRejectEdit(request: EditTarget, annotation: string): AppendRow[] {
  return [
    {
      kind: 'REJECT_MARKER',
      eventType: request.eventType,
      eventCode: request.eventCode,
      at: request.eventDateTime,
      recordStatus: 4,
      recordOrigin: 3,
      supersedesId: request.id,
      annotation,
    },
  ];
}

/**
 * §9.3 — the driver's own correction. Active immediately (`recordStatus = 1`), origin `2`
 * (genuinely driver-entered), and it never needs anyone's approval because it is the driver's
 * own record.
 */
export function planDriverSelfEdit(proposal: ProposalInput, target?: EditTarget): AppendRow[] {
  const rows: AppendRow[] = [];

  if (target) {
    rows.push({
      kind: 'INACTIVE_MARKER',
      eventType: target.eventType,
      eventCode: target.eventCode,
      at: target.eventDateTime,
      recordStatus: 2,
      recordOrigin: 2,
      supersedesId: target.id,
      annotation: proposal.annotation,
    });
    if (needsNeutralizer(target, proposal)) {
      // bugs.md B-049 — a driver-entered (origin 2) driving record is manual driving time
      // (§395.26(b)). `checkDriverSelfEdit` refuses this shape with EXTENDS_DRIVING before the
      // planner runs; this is the invariant that keeps any other caller honest.
      if (proposal.statusBeforeTarget === 'D') {
        throw new Error('planDriverSelfEdit: a driver edit cannot back-fill a gap with driving time (B-049)');
      }
      rows.push({
        kind: 'NEUTRALIZE',
        eventType: DUTY,
        eventCode: DUTY_CODE_BY_STATUS[proposal.statusBeforeTarget as DutyStatus],
        at: target.eventDateTime,
        recordStatus: 1,
        recordOrigin: 2,
        supersedesId: target.id,
        annotation: proposal.annotation,
      });
    }
  }

  rows.push({
    kind: 'NEW_ACTIVE',
    eventType: DUTY,
    eventCode: DUTY_CODE_BY_STATUS[proposal.status],
    at: proposal.startAt,
    recordStatus: 1,
    recordOrigin: 2,
    supersedesId: target ? target.id : null,
    annotation: proposal.annotation,
  });

  if (proposal.endAt && proposal.statusAfterInterval) {
    rows.push({
      kind: 'RESTORE',
      eventType: DUTY,
      eventCode: DUTY_CODE_BY_STATUS[proposal.statusAfterInterval],
      at: proposal.endAt,
      recordStatus: 1,
      recordOrigin: 2,
      supersedesId: null,
      annotation: proposal.annotation,
    });
  }

  return rows;
}
