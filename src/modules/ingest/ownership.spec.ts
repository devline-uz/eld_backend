import { RECORD_ORIGIN } from './event-codes';
import { resolveStoredEventOwner } from './ownership';

const at = new Date('2025-09-10T11:20:00Z');

describe('ingest/ownership — §7.4 ordered ladder', () => {
  it('rule 1: an open session on the unit owns the events, with no segment and no prompt', () => {
    const decision = resolveStoredEventOwner(at, {
      openSessionDriverId: 'drv_john',
      lastBefore: { driverId: 'drv_other', at: new Date('2025-09-10T09:00:00Z') },
      firstAfter: { driverId: 'drv_other', at: new Date('2025-09-10T12:00:00Z') },
    });
    expect(decision).toEqual({
      driverId: 'drv_john',
      recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
      rule: 1,
      requiresConfirmation: false,
      createsUnidentifiedSegment: false,
    });
  });

  it('rule 1 wins over rule 2 — first match wins, later rules are not evaluated', () => {
    const decision = resolveStoredEventOwner(at, {
      openSessionDriverId: 'drv_john',
      lastBefore: { driverId: 'drv_mary', at: new Date('2025-09-10T11:00:00Z') },
      firstAfter: { driverId: 'drv_mary', at: new Date('2025-09-10T11:30:00Z') },
    });
    expect(decision.driverId).toBe('drv_john');
    expect(decision.rule).toBe(1);
  });

  it('rule 2: same driver on both sides of a ≤ 2 h gap → assigned + confirmation requested', () => {
    const decision = resolveStoredEventOwner(at, {
      openSessionDriverId: null,
      lastBefore: { driverId: 'drv_mary', at: new Date('2025-09-10T11:00:00Z') },
      firstAfter: { driverId: 'drv_mary', at: new Date('2025-09-10T12:30:00Z') },
    });
    expect(decision.driverId).toBe('drv_mary');
    expect(decision.rule).toBe(2);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.createsUnidentifiedSegment).toBe(false);
  });

  it('rule 2 does not apply when the gap exceeds 2 hours', () => {
    const decision = resolveStoredEventOwner(at, {
      openSessionDriverId: null,
      lastBefore: { driverId: 'drv_mary', at: new Date('2025-09-10T10:00:00Z') },
      firstAfter: { driverId: 'drv_mary', at: new Date('2025-09-10T13:00:00Z') },
    });
    expect(decision.rule).toBe(3);
  });

  it('rule 2 does not apply when the drivers differ', () => {
    const decision = resolveStoredEventOwner(at, {
      openSessionDriverId: null,
      lastBefore: { driverId: 'drv_mary', at: new Date('2025-09-10T11:00:00Z') },
      firstAfter: { driverId: 'drv_bob', at: new Date('2025-09-10T11:40:00Z') },
    });
    expect(decision.rule).toBe(3);
  });

  it('rule 3: unknown ownership → null driver, origin 4, segment created (events kept)', () => {
    const decision = resolveStoredEventOwner(at, {
      openSessionDriverId: null,
      lastBefore: null,
      firstAfter: null,
    });
    expect(decision).toEqual({
      driverId: null,
      recordOrigin: RECORD_ORIGIN.UNIDENTIFIED,
      rule: 3,
      requiresConfirmation: false,
      createsUnidentifiedSegment: true,
    });
  });

  it('never produces recordOrigin 2 — that value means genuinely driver-entered (§395.30)', () => {
    const windows = [
      { openSessionDriverId: 'd1', lastBefore: null, firstAfter: null },
      {
        openSessionDriverId: null,
        lastBefore: { driverId: 'd1', at: new Date('2025-09-10T11:00:00Z') },
        firstAfter: { driverId: 'd1', at: new Date('2025-09-10T11:30:00Z') },
      },
      { openSessionDriverId: null, lastBefore: null, firstAfter: null },
    ];
    for (const window of windows) {
      expect(resolveStoredEventOwner(at, window).recordOrigin).not.toBe(
        RECORD_ORIGIN.DRIVER_ENTERED,
      );
    }
  });
});
