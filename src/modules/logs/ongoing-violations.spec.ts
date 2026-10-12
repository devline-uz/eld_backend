/**
 * W-08 — a violation filed on the day a limit was crossed is still IN FORCE on the next RODS day
 * when the driver keeps driving over midnight without a 10-hour reset (QA: 24:00 of driving
 * under "No violations today").
 */
import { dayStart } from '../hos/engine/timezone';
import { ongoingViolationsAtDayStart } from './ongoing-violations';
import type { RodsEvent } from './rods';

const TZ = 'America/New_York';
let sequence = 0;

function event(at: string, code: number, partial: Partial<RodsEvent> = {}): RodsEvent {
  sequence += 1;
  return {
    id: BigInt(sequence),
    eventType: 1,
    eventCode: code,
    eventDateTime: new Date(at),
    recordStatus: 1,
    recordOrigin: 1,
    eventSequenceId: sequence,
    supersedesId: null,
    ...partial,
  };
}

beforeEach(() => {
  sequence = 0;
});

const driver = { driverId: 'driver-1' };

describe('ongoingViolationsAtDayStart', () => {
  it('reports 11 h, 14 h and 30 min still in force when an open DRIVING record crosses midnight', () => {
    // 2026-10-08 03:24 ET on duty, 03:44 driving — and the ELD never reported a stop.
    const events = [event('2026-10-08T07:24:00Z', 4), event('2026-10-08T07:44:00Z', 3)];
    const startAt = dayStart(TZ, '2026-10-10');

    const ongoing = ongoingViolationsAtDayStart({
      events,
      driver,
      ruleset: 'US_70_8_PROPERTY',
      timezone: TZ,
      dayStartAt: startAt,
      now: new Date('2026-10-10T16:00:00Z'),
    });

    expect(ongoing.map((v) => v.type).sort()).toEqual(['BREAK_30', 'DRIVING_11', 'SHIFT_14']);
    for (const violation of ongoing) expect(violation.inForceSince).toEqual(startAt);
    // 11 h of driving from 03:44 ET → crossed at 14:44 ET on the 8th.
    expect(ongoing.find((v) => v.type === 'DRIVING_11')?.crossedAt?.toISOString()).toBe('2026-10-08T18:44:00.000Z');
    // The 14-hour window opened at 03:24 ET → closed at 17:24 ET on the 8th.
    expect(ongoing.find((v) => v.type === 'SHIFT_14')?.crossedAt?.toISOString()).toBe('2026-10-08T21:24:00.000Z');
  });

  it('reports nothing when the driver is not driving at midnight (an expired window alone is no violation)', () => {
    // On duty, not driving, for two days: the window is long gone but on-duty time is legal.
    const events = [event('2026-10-08T08:44:00Z', 4)];
    const ongoing = ongoingViolationsAtDayStart({
      events,
      driver,
      ruleset: 'US_70_8_PROPERTY',
      timezone: TZ,
      dayStartAt: dayStart(TZ, '2026-10-10'),
      now: new Date('2026-10-10T16:00:00Z'),
    });
    expect(ongoing).toEqual([]);
  });

  it('reports nothing for legal driving that crosses midnight', () => {
    // A fresh shift: on duty 22:00 ET, driving from 22:15 ET — 1 h 45 min of driving at midnight.
    const events = [event('2026-10-08T00:00:00Z', 1), event('2026-10-10T02:00:00Z', 4), event('2026-10-10T02:15:00Z', 3)];
    const ongoing = ongoingViolationsAtDayStart({
      events,
      driver,
      ruleset: 'US_70_8_PROPERTY',
      timezone: TZ,
      dayStartAt: dayStart(TZ, '2026-10-10'),
      now: new Date('2026-10-10T16:00:00Z'),
    });
    expect(ongoing).toEqual([]);
  });

  it('ignores records retired by an "Inactive — Changed" marker', () => {
    const driving = event('2026-10-08T07:44:00Z', 3);
    const events = [
      event('2026-10-08T07:24:00Z', 4),
      driving,
      // The carrier's accepted edit turned that DRIVING record into OFF duty.
      event('2026-10-08T07:44:00Z', 3, { recordStatus: 2, supersedesId: driving.id }),
      event('2026-10-08T07:44:00Z', 1),
    ];
    const ongoing = ongoingViolationsAtDayStart({
      events,
      driver,
      ruleset: 'US_70_8_PROPERTY',
      timezone: TZ,
      dayStartAt: dayStart(TZ, '2026-10-10'),
      now: new Date('2026-10-10T16:00:00Z'),
    });
    expect(ongoing).toEqual([]);
  });

  it('carries nothing into a day that has not started yet', () => {
    const events = [event('2026-10-08T07:44:00Z', 3)];
    const ongoing = ongoingViolationsAtDayStart({
      events,
      driver,
      ruleset: 'US_70_8_PROPERTY',
      timezone: TZ,
      dayStartAt: dayStart(TZ, '2026-10-12'),
      now: new Date('2026-10-10T16:00:00Z'),
    });
    expect(ongoing).toEqual([]);
  });

  it('does not report the 30-minute break for a short-haul driver', () => {
    const events = [event('2026-10-08T07:24:00Z', 4), event('2026-10-08T07:44:00Z', 3)];
    const ongoing = ongoingViolationsAtDayStart({
      events,
      driver: { ...driver, shortHaulException: true },
      ruleset: 'US_70_8_PROPERTY',
      timezone: TZ,
      dayStartAt: dayStart(TZ, '2026-10-10'),
      now: new Date('2026-10-10T16:00:00Z'),
    });
    expect(ongoing.map((v) => v.type).sort()).toEqual(['DRIVING_11', 'SHIFT_14']);
  });
});
