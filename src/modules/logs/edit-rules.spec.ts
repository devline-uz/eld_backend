/** 49 CFR §395.30(c)(2) / TZ §9.1, §9.3 — driving time can never be reduced. */
import { checkDriverSelfEdit, checkEditProposal, isDrivingRecord, overlaps } from './edit-rules';

const drivingTarget = {
  eventType: 1,
  eventCode: 3,
  eventDateTime: new Date('2026-06-01T12:00:00Z'),
  intervalEndAt: new Date('2026-06-01T15:00:00Z'),
};
const onDutyTarget = {
  eventType: 1,
  eventCode: 4,
  eventDateTime: new Date('2026-06-01T08:00:00Z'),
  intervalEndAt: new Date('2026-06-01T09:00:00Z'),
};
const driving = [{ startAt: new Date('2026-06-01T12:00:00Z'), endAt: new Date('2026-06-01T15:00:00Z') }];

describe('checkEditProposal — carrier edit (§395.30)', () => {
  it('refuses restatusing driving time to on duty', () => {
    expect(
      checkEditProposal(drivingTarget, {
        proposedStatus: 'ON',
        proposedStart: drivingTarget.eventDateTime,
        proposedEnd: drivingTarget.intervalEndAt,
      }),
    ).toBe('RESTATUS_DRIVING');
  });

  it('refuses shortening driving time from the start', () => {
    expect(
      checkEditProposal(drivingTarget, {
        proposedStatus: 'D',
        proposedStart: new Date('2026-06-01T13:00:00Z'),
        proposedEnd: drivingTarget.intervalEndAt,
      }),
    ).toBe('SHORTEN_DRIVING');
  });

  it('refuses shortening driving time from the end', () => {
    expect(
      checkEditProposal(drivingTarget, {
        proposedStatus: 'D',
        proposedStart: drivingTarget.eventDateTime,
        proposedEnd: new Date('2026-06-01T14:00:00Z'),
      }),
    ).toBe('SHORTEN_DRIVING');
  });

  it('allows an annotation-only edit of a driving record', () => {
    expect(
      checkEditProposal(drivingTarget, {
        proposedStatus: 'D',
        proposedStart: drivingTarget.eventDateTime,
        proposedEnd: drivingTarget.intervalEndAt,
      }),
    ).toBeNull();
  });

  it('allows extending driving time', () => {
    expect(
      checkEditProposal(drivingTarget, {
        proposedStatus: 'D',
        proposedStart: new Date('2026-06-01T11:30:00Z'),
        proposedEnd: new Date('2026-06-01T15:30:00Z'),
      }),
    ).toBeNull();
  });

  it('refuses moving a non-driving record on top of driving time', () => {
    expect(
      checkEditProposal(
        onDutyTarget,
        {
          proposedStatus: 'ON',
          proposedStart: new Date('2026-06-01T11:00:00Z'),
          proposedEnd: new Date('2026-06-01T13:00:00Z'),
        },
        driving,
      ),
    ).toBe('OVERLAPS_DRIVING');
  });

  it('allows a non-driving edit that stays clear of driving time', () => {
    expect(
      checkEditProposal(
        onDutyTarget,
        {
          proposedStatus: 'SB',
          proposedStart: new Date('2026-06-01T07:00:00Z'),
          proposedEnd: new Date('2026-06-01T09:00:00Z'),
        },
        driving,
      ),
    ).toBeNull();
  });
});

describe('checkDriverSelfEdit — the driver may not touch the D segment (§9.3)', () => {
  it('refuses a hand-entered driving record', () => {
    expect(
      checkDriverSelfEdit(
        { status: 'D', startAt: new Date('2026-06-01T06:00:00Z'), endAt: new Date('2026-06-01T07:00:00Z') },
        driving,
      ),
    ).toBe('MANUAL_DRIVING');
  });

  it('refuses restatusing an existing driving record', () => {
    expect(
      checkDriverSelfEdit(
        { status: 'ON', startAt: drivingTarget.eventDateTime, endAt: drivingTarget.intervalEndAt },
        driving,
        drivingTarget,
      ),
    ).toBe('RESTATUS_DRIVING');
  });

  it('refuses an entry that overlaps driving time', () => {
    expect(
      checkDriverSelfEdit(
        { status: 'ON', startAt: new Date('2026-06-01T14:00:00Z'), endAt: new Date('2026-06-01T16:00:00Z') },
        driving,
      ),
    ).toBe('OVERLAPS_DRIVING');
  });

  it('allows a forgotten on-duty interval before the driving segment', () => {
    expect(
      checkDriverSelfEdit(
        { status: 'ON', startAt: new Date('2026-06-01T10:00:00Z'), endAt: new Date('2026-06-01T12:00:00Z') },
        driving,
      ),
    ).toBeNull();
  });

  it('allows an open-ended entry', () => {
    expect(
      checkDriverSelfEdit({ status: 'SB', startAt: new Date('2026-06-01T16:00:00Z') }, driving),
    ).toBeNull();
  });

  // bugs.md B-049 — moving the record that FOLLOWS driving later would back-fill the gap with D.
  it('refuses moving the record right after driving LATER (would extend driving, §395.26(b))', () => {
    const onAfterDriving = {
      eventType: 1,
      eventCode: 4,
      eventDateTime: drivingTarget.intervalEndAt,
      intervalEndAt: new Date('2026-06-01T18:00:00Z'),
      statusBefore: 'D' as const,
    };
    expect(
      checkDriverSelfEdit(
        { status: 'ON', startAt: new Date('2026-06-01T15:06:00Z') },
        driving,
        onAfterDriving,
      ),
    ).toBe('EXTENDS_DRIVING');
  });

  it('allows moving the record right after driving EARLIER only when it does not overlap driving', () => {
    const onAfterDriving = {
      eventType: 1,
      eventCode: 4,
      eventDateTime: drivingTarget.intervalEndAt,
      intervalEndAt: new Date('2026-06-01T18:00:00Z'),
      statusBefore: 'D' as const,
    };
    expect(
      checkDriverSelfEdit(
        { status: 'SB', startAt: drivingTarget.intervalEndAt },
        driving,
        onAfterDriving,
      ),
    ).toBeNull();
  });
});

describe('helpers', () => {
  it('recognises the driving record (eventType 1, eventCode 3)', () => {
    expect(isDrivingRecord({ eventType: 1, eventCode: 3 })).toBe(true);
    expect(isDrivingRecord({ eventType: 1, eventCode: 4 })).toBe(false);
    expect(isDrivingRecord({ eventType: 3, eventCode: 3 })).toBe(false);
  });

  it('treats a shared boundary instant as no overlap', () => {
    const a = { startAt: new Date('2026-06-01T10:00:00Z'), endAt: new Date('2026-06-01T12:00:00Z') };
    const b = { startAt: new Date('2026-06-01T12:00:00Z'), endAt: new Date('2026-06-01T14:00:00Z') };
    expect(overlaps(a, b)).toBe(false);
  });
});
