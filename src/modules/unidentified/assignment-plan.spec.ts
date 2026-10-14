/** CODE-007 — the pure overlap / restore plan of an unidentified-driving assignment. */
import type { RodsEvent } from '../logs/rods';
import { planAssignmentAgainstDriverLog } from './assignment-plan';

const at = (hhmm: string) => new Date(`2026-06-01T${hhmm}:00Z`);
let seq = 1;
const ev = (eventType: number, eventCode: number, when: Date, extra: Partial<RodsEvent> = {}): RodsEvent => ({
  id: BigInt(seq),
  eventType,
  eventCode,
  eventDateTime: when,
  recordStatus: 1,
  recordOrigin: 1,
  eventSequenceId: seq++,
  supersedesId: null,
  ...extra,
});
const SEGMENT = { startAt: at('10:00'), endAt: at('12:00') };

describe('planAssignmentAgainstDriverLog (CODE-007)', () => {
  it('a driver with no record at all is restored to OFF (§395.8(a))', () => {
    expect(planAssignmentAgainstDriverLog([], SEGMENT)).toEqual({ conflict: null, restoreStatus: 'OFF' });
  });

  it('restores the status in force on the driver\'s own timeline (SB stays SB)', () => {
    expect(planAssignmentAgainstDriverLog([ev(1, 2, at('08:00'))], SEGMENT)).toEqual({ conflict: null, restoreStatus: 'SB' });
  });

  it('a record exactly at the segment end is an own record taking over — no restore, no conflict', () => {
    expect(planAssignmentAgainstDriverLog([ev(1, 1, at('08:00')), ev(1, 4, at('12:00'))], SEGMENT)).toEqual({ conflict: null, restoreStatus: null });
  });

  it('a record exactly at the segment start overlaps it', () => {
    const plan = planAssignmentAgainstDriverLog([ev(1, 1, at('08:00')), ev(1, 4, at('10:00'))], SEGMENT);
    expect(plan.conflict).toEqual({ reason: 'OWN_RECORDS_INSIDE', conflictingAt: [at('10:00')] });
  });

  it('a PC / YM indication in force at the start is refused (the driver was already moving a CMV)', () => {
    const plan = planAssignmentAgainstDriverLog([ev(1, 1, at('08:00')), ev(3, 1, at('08:00'))], SEGMENT);
    expect(plan.conflict).toEqual({ reason: 'SPECIAL_AT_START', conflictingAt: [] });
  });

  it('DRIVING in force at the start is refused', () => {
    expect(planAssignmentAgainstDriverLog([ev(1, 3, at('09:00'))], SEGMENT).conflict?.reason).toBe('DRIVING_AT_START');
  });

  it('a record retired by an "Inactive — Changed" marker is ignored, as on the RODS log', () => {
    const retired = ev(1, 3, at('09:00'));
    const plan = planAssignmentAgainstDriverLog(
      [ev(1, 1, at('08:00')), retired, ev(1, 3, at('09:00'), { recordStatus: 2, recordOrigin: 3, supersedesId: retired.id })],
      SEGMENT,
    );
    expect(plan).toEqual({ conflict: null, restoreStatus: 'OFF' });
  });
});
