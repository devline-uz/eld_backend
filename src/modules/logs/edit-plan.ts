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
 *   SPECIAL          eventType 3, code 1 (PC) / 2 (YM)             B-39 — the §395.1(e)
 *                                                                 category of an accepted edit
 *   SPECIAL_CLEAR    eventType 3, code 0                           ends that category at the
 *                                                                 end of the edited interval
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
  | 'REJECT_MARKER'
  | 'SPECIAL'
  | 'SPECIAL_CLEAR';

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
  /** B-39 — §395.1(e) special driving category the accepted record carries. */
  special?: SpecialCategory;
  /**
   * B-39 — where an open-ended PC/YM interval ends (the next active record). `null` when the
   * interval is still open (nothing follows it yet): the category then stays in force until
   * the driver's next duty-status change clears it, exactly as a device-entered PC/YM does.
   */
  specialClearAt?: Date | null;
  /** MR-23 — §395.1(e) category in force immediately before `startAt` (driver self-entry). */
  specialBefore?: SpecialCategory;
  /** MR-23 — category in force at `endAt` on the old timeline, re-asserted after the RESTORE. */
  specialAfterInterval?: SpecialCategory;
}

export type SpecialCategory = 'NONE' | 'PC' | 'YM';

/** Appendix A eventType 3 — 0 cleared, 1 personal conveyance, 2 yard move. */
export const SPECIAL_EVENT_TYPE = 3;
export const SPECIAL_CODE: Record<SpecialCategory, number> = { NONE: 0, PC: 1, YM: 2 };
export const SPECIAL_BY_CODE: Record<number, SpecialCategory> = { 0: 'NONE', 1: 'PC', 2: 'YM' };

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

/**
 * B-72 — a carrier proposal of a NEW record (no original to replace — e.g. a RODS day with no
 * duty record yet). Inert like any §395.30 proposal: recordStatus 3, nothing counts until the
 * driver accepts.
 */
export function planProposedEvent(proposal: ProposalInput): AppendRow[] {
  return [
    {
      kind: 'REQUEST',
      eventType: DUTY,
      eventCode: DUTY_CODE_BY_STATUS[proposal.status],
      at: proposal.startAt,
      recordStatus: 3,
      recordOrigin: 3,
      supersedesId: null,
      annotation: proposal.annotation,
    },
  ];
}

/**
 * §9.1 step 3 — driver accepted: old record 2, proposal becomes the active record. `target` is
 * `null` for an accepted B-72 proposed event: there is no original to retire.
 */
export function planAcceptEdit(
  request: EditTarget,
  target: EditTarget | null,
  proposal: ProposalInput,
): AppendRow[] {
  const rows: AppendRow[] = [];
  if (target) {
    rows.push({
      kind: 'INACTIVE_MARKER',
      eventType: target.eventType,
      eventCode: target.eventCode,
      at: target.eventDateTime,
      recordStatus: 2,
      recordOrigin: 3,
      supersedesId: target.id,
      annotation: proposal.annotation,
    });
  }

  if (target && needsNeutralizer(target, proposal)) {
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

  // B-39 — the §395.1(e) category is its own Appendix A record (eventType 3), appended right
  // after the duty-status record at the same instant so it re-states that status under PC/YM
  // (later sequence wins, `hos-event-mapper`). Origin 3: entered by another authorised user.
  const special = proposal.special ?? 'NONE';
  if (special !== 'NONE') {
    rows.push({
      kind: 'SPECIAL',
      eventType: SPECIAL_EVENT_TYPE,
      eventCode: SPECIAL_CODE[special],
      at: proposal.startAt,
      recordStatus: 1,
      recordOrigin: 3,
      supersedesId: null,
      annotation: proposal.annotation,
    });
  }

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

  // B-39 — the category must not outlive the edited interval: a PC edit followed by an OFF
  // record would otherwise keep counting as PC. Cleared after the RESTORE at the same instant.
  const clearAt = proposal.endAt ?? proposal.specialClearAt ?? null;
  if (special !== 'NONE' && clearAt) {
    rows.push({
      kind: 'SPECIAL_CLEAR',
      eventType: SPECIAL_EVENT_TYPE,
      eventCode: SPECIAL_CODE.NONE,
      at: clearAt,
      recordStatus: 1,
      recordOrigin: 3,
      supersedesId: null,
      annotation: proposal.annotation,
    });
  }

  return rows;
}

/**
 * B-39 / B-72 — what a pending proposal carries beyond its own columns. `EldEvent` has no
 * column for the proposed end, the PC/YM category or "insert vs. replace", and the table is
 * append-only, so they travel in the proposal row's free-text `comment` as `key=value` tokens
 * (the pre-existing `proposedEnd=` convention). `comment` is never an Appendix A field on a
 * proposal row: the annotation is (`snapshot.ts` prefers `annotation`).
 */
export interface ProposalMeta {
  proposedEnd: Date | null;
  special: SpecialCategory;
}

export function formatProposalMeta(meta: Partial<ProposalMeta>): string | null {
  const tokens: string[] = [];
  if (meta.proposedEnd) tokens.push(`proposedEnd=${meta.proposedEnd.toISOString()}`);
  if (meta.special && meta.special !== 'NONE') tokens.push(`proposedSpecial=${meta.special}`);
  return tokens.length ? tokens.join(' ') : null;
}

export function parseProposalMeta(comment: string | null | undefined): ProposalMeta {
  const out: ProposalMeta = { proposedEnd: null, special: 'NONE' };
  if (!comment) return out;
  const end = /proposedEnd=(\S+)/.exec(comment);
  if (end) {
    const parsed = new Date(end[1]);
    if (Number.isFinite(parsed.getTime())) out.proposedEnd = parsed;
  }
  const special = /proposedSpecial=(PC|YM)\b/.exec(comment);
  if (special) out.special = special[1] as SpecialCategory;
  return out;
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

  // MR-23 — a plain status entered while PC/YM is in force ENDS that category: Appendix A
  // records it as eventType 3 code 0 ("cleared"). Without it an OFF after PC (or ON after YM)
  // would keep counting as PC/YM (`hos-event-mapper` carries the category forward).
  const special = proposal.special ?? 'NONE';
  const specialBefore = proposal.specialBefore ?? 'NONE';
  if (special === 'NONE' && specialBefore !== 'NONE') {
    rows.push(selfSpecialRow('SPECIAL_CLEAR', 'NONE', proposal.startAt, proposal.annotation));
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

  // MR-23 — the §395.1(e) category is its own Appendix A record (eventType 3, code 1 PC /
  // 2 YM), right after the duty-status record at the same instant (later sequence wins).
  if (special !== 'NONE') {
    rows.push(selfSpecialRow('SPECIAL', special, proposal.startAt, proposal.annotation));
  }

  if (proposal.endAt && special !== 'NONE') {
    rows.push(selfSpecialRow('SPECIAL_CLEAR', 'NONE', proposal.endAt, proposal.annotation));
  }

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
    // MR-23 — an inserted interval must not end a PC/YM that was in force after it.
    const after = proposal.specialAfterInterval ?? 'NONE';
    if (after !== 'NONE') {
      rows.push(selfSpecialRow('SPECIAL', after, proposal.endAt, proposal.annotation));
    }
  }

  return rows;
}

function selfSpecialRow(kind: 'SPECIAL' | 'SPECIAL_CLEAR', special: SpecialCategory, at: Date, annotation: string): AppendRow {
  return {
    kind,
    eventType: SPECIAL_EVENT_TYPE,
    eventCode: SPECIAL_CODE[special],
    at,
    recordStatus: 1,
    recordOrigin: 2,
    supersedesId: null,
    annotation,
  };
}
