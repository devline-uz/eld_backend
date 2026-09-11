/**
 * TZ §9.1 / §9.3 on an append-only ledger (D-019) — every record-status transition is an
 * APPENDED record, because `EldEvent` has UPDATE revoked at the database level.
 */
import { planAcceptEdit, planDriverSelfEdit, planEditRequest, planRejectEdit } from './edit-plan';

const target = {
  id: 10n,
  eventType: 1,
  eventCode: 4,
  eventDateTime: new Date('2026-06-01T12:00:00Z'),
};
const request = { id: 20n, eventType: 1, eventCode: 2, eventDateTime: new Date('2026-06-01T13:00:00Z') };

describe('planEditRequest', () => {
  it('produces exactly one INERT record: status 3, origin 3, pointing at the original', () => {
    const rows = planEditRequest(target, {
      status: 'SB',
      startAt: new Date('2026-06-01T13:00:00Z'),
      annotation: 'Sleeper berth, not on duty',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'REQUEST', recordStatus: 3, recordOrigin: 3, eventCode: 2, supersedesId: 10n });
  });
});

describe('planAcceptEdit', () => {
  it('retires the original, neutralises its instant and activates the proposal', () => {
    const rows = planAcceptEdit(request, target, {
      status: 'SB',
      startAt: request.eventDateTime,
      annotation: 'Accepted',
      statusBeforeTarget: 'OFF',
      statusAfterInterval: 'ON',
      endAt: new Date('2026-06-01T15:00:00Z'),
    });

    expect(rows.map((row) => row.kind)).toEqual(['INACTIVE_MARKER', 'NEUTRALIZE', 'NEW_ACTIVE', 'RESTORE']);
    // The "Inactive — Changed" row of §395.30 / Appendix A.
    expect(rows[0]).toMatchObject({ recordStatus: 2, supersedesId: 10n, at: target.eventDateTime });
    // The neutraliser re-states the status that preceded the original, at the original instant.
    expect(rows[1]).toMatchObject({ recordStatus: 1, eventCode: 1, at: target.eventDateTime });
    expect(rows[2]).toMatchObject({ recordStatus: 1, recordOrigin: 3, eventCode: 2, supersedesId: 20n });
    expect(rows[3]).toMatchObject({ recordStatus: 1, eventCode: 4, at: new Date('2026-06-01T15:00:00Z') });
  });

  it('skips the neutraliser when the proposal keeps the original instant', () => {
    const rows = planAcceptEdit(
      { ...request, eventDateTime: target.eventDateTime },
      target,
      { status: 'SB', startAt: target.eventDateTime, annotation: 'Accepted', statusBeforeTarget: 'OFF' },
    );
    expect(rows.map((row) => row.kind)).toEqual(['INACTIVE_MARKER', 'NEW_ACTIVE']);
  });
});

describe('planRejectEdit', () => {
  it('closes the request with status 4 and changes nothing else', () => {
    const rows = planRejectEdit(request, 'Not my record');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'REJECT_MARKER', recordStatus: 4, supersedesId: 20n });
  });
});

describe('planDriverSelfEdit', () => {
  it('is active immediately and driver-entered (§9.3: recordOrigin 2, recordStatus 1)', () => {
    const rows = planDriverSelfEdit({
      status: 'ON',
      startAt: new Date('2026-06-01T18:00:00Z'),
      endAt: new Date('2026-06-01T18:45:00Z'),
      annotation: 'Loading at shipper #4821',
      statusAfterInterval: 'OFF',
    });
    expect(rows.map((row) => row.kind)).toEqual(['NEW_ACTIVE', 'RESTORE']);
    expect(rows[0]).toMatchObject({ recordStatus: 1, recordOrigin: 2, eventCode: 4, supersedesId: null });
    expect(rows[1]).toMatchObject({ recordStatus: 1, recordOrigin: 2, eventCode: 1 });
  });

  it('retires the corrected record when one is named', () => {
    const rows = planDriverSelfEdit(
      {
        status: 'SB',
        startAt: new Date('2026-06-01T13:00:00Z'),
        annotation: 'Was in the bunk',
        statusBeforeTarget: 'OFF',
      },
      target,
    );
    expect(rows.map((row) => row.kind)).toEqual(['INACTIVE_MARKER', 'NEUTRALIZE', 'NEW_ACTIVE']);
    expect(rows[0]).toMatchObject({ recordStatus: 2, recordOrigin: 2, supersedesId: 10n });
    expect(rows[2]).toMatchObject({ recordStatus: 1, recordOrigin: 2, supersedesId: 10n });
  });
});
