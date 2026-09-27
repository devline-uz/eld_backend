/**
 * TZ §9.1 / §9.3 on an append-only ledger (D-019) — every record-status transition is an
 * APPENDED record, because `EldEvent` has UPDATE revoked at the database level.
 */
import {
  formatProposalMeta,
  parseProposalMeta,
  planAcceptEdit,
  planDriverSelfEdit,
  planEditRequest,
  planProposedEvent,
  planRejectEdit,
} from './edit-plan';

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

  it('skips the neutraliser when the proposal starts EARLIER — driving extended earlier stays driving (§395.30(c)(2))', () => {
    const drivingTarget = { id: 10n, eventType: 1, eventCode: 3, eventDateTime: new Date('2026-06-01T12:00:00Z') };
    const earlier = new Date('2026-06-01T11:50:00Z');
    const rows = planAcceptEdit(
      { id: 20n, eventType: 1, eventCode: 3, eventDateTime: earlier },
      drivingTarget,
      { status: 'D', startAt: earlier, annotation: 'ECM shows earlier departure', statusBeforeTarget: 'ON' },
    );
    // A neutraliser at 12:00 would re-state ON over the whole driving interval.
    expect(rows.map((row) => row.kind)).toEqual(['INACTIVE_MARKER', 'NEW_ACTIVE']);
    expect(rows[1]).toMatchObject({ eventCode: 3, at: earlier, recordStatus: 1 });
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

  it('does not neutralise when the driver moves a record EARLIER', () => {
    const rows = planDriverSelfEdit(
      {
        status: 'ON',
        startAt: new Date('2026-06-01T11:40:00Z'),
        annotation: 'Pre-trip started earlier',
        statusBeforeTarget: 'OFF',
      },
      target,
    );
    expect(rows.map((row) => row.kind)).toEqual(['INACTIVE_MARKER', 'NEW_ACTIVE']);
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

  // bugs.md B-049 — a driver plan must never contain a driving NEUTRALIZE row.
  it('never emits a driving NEUTRALIZE (driver edits cannot create driving time, §395.26(b))', () => {
    expect(() =>
      planDriverSelfEdit(
        {
          status: 'ON',
          startAt: new Date('2026-06-01T12:06:00Z'),
          annotation: 'Started later',
          statusBeforeTarget: 'D',
        },
        target,
      ),
    ).toThrow(/driving/i);
  });
});

describe('B-39 / B-72 — special category and proposed new records', () => {
  it('planProposedEvent is one inert record with no original', () => {
    const rows = planProposedEvent({ status: 'ON', startAt: new Date('2026-06-03T13:00:00Z'), annotation: 'Pre-trip inspection' });
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'REQUEST', recordStatus: 3, recordOrigin: 3, supersedesId: null, eventType: 1, eventCode: 4 }),
    ]);
  });

  it('accepting a proposed record (no target) retires nothing and neutralizes nothing', () => {
    const rows = planAcceptEdit(request, null, {
      status: 'SB',
      startAt: request.eventDateTime,
      endAt: new Date('2026-06-01T15:00:00Z'),
      annotation: 'Sleeper',
      statusAfterInterval: 'OFF',
    });
    expect(rows.map((row) => row.kind)).toEqual(['NEW_ACTIVE', 'RESTORE']);
  });

  it('a PC edit appends eventType 3 code 1 after the duty record and clears it at the next record', () => {
    const rows = planAcceptEdit(request, target, {
      status: 'OFF',
      startAt: target.eventDateTime,
      annotation: 'Personal conveyance to the motel',
      special: 'PC',
      specialClearAt: new Date('2026-06-01T16:00:00Z'),
    });
    const kinds = rows.map((row) => row.kind);
    expect(kinds.indexOf('SPECIAL')).toBeGreaterThan(kinds.indexOf('NEW_ACTIVE'));
    expect(rows.find((row) => row.kind === 'SPECIAL')).toMatchObject({ eventType: 3, eventCode: 1, recordOrigin: 3 });
    expect(rows.find((row) => row.kind === 'SPECIAL_CLEAR')).toMatchObject({
      eventType: 3,
      eventCode: 0,
      at: new Date('2026-06-01T16:00:00Z'),
    });
  });

  it('an open-ended YM interval with nothing after it is not cleared (the next status change clears it)', () => {
    const rows = planAcceptEdit(request, target, {
      status: 'ON',
      startAt: target.eventDateTime,
      annotation: 'Yard move',
      special: 'YM',
      specialClearAt: null,
    });
    expect(rows.some((row) => row.kind === 'SPECIAL_CLEAR')).toBe(false);
    expect(rows.find((row) => row.kind === 'SPECIAL')).toMatchObject({ eventCode: 2 });
  });

  it('NONE adds no eventType 3 record (no spurious Appendix A rows)', () => {
    const rows = planAcceptEdit(request, target, { status: 'ON', startAt: target.eventDateTime, annotation: 'Loading' });
    expect(rows.some((row) => row.eventType === 3)).toBe(false);
  });

  it('proposal meta round-trips through the comment column', () => {
    const end = new Date('2026-06-01T13:00:00.000Z');
    expect(parseProposalMeta(formatProposalMeta({ proposedEnd: end, special: 'YM' }))).toEqual({ proposedEnd: end, special: 'YM' });
    expect(formatProposalMeta({ proposedEnd: null, special: 'NONE' })).toBeNull();
    expect(parseProposalMeta(null)).toEqual({ proposedEnd: null, special: 'NONE' });
    // Legacy rows written before B-39 carry only `proposedEnd=`.
    expect(parseProposalMeta(`proposedEnd=${end.toISOString()}`)).toEqual({ proposedEnd: end, special: 'NONE' });
  });
});
