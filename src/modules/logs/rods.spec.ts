/** TZ §9 / §23 — the RODS day is split by the driver's home terminal timezone. */
import { activeRecords, buildRodsDay, drivingIntervals, statusInEffectAt, supersededEventIds, type RodsEvent } from './rods';

const TZ = 'America/New_York';
let sequence = 0;

function event(partial: Partial<RodsEvent> & { at: string; code: number }): RodsEvent {
  sequence += 1;
  return {
    id: BigInt(sequence),
    eventType: partial.eventType ?? 1,
    eventCode: partial.code,
    eventDateTime: new Date(partial.at),
    recordStatus: partial.recordStatus ?? 1,
    recordOrigin: partial.recordOrigin ?? 1,
    eventSequenceId: partial.eventSequenceId ?? sequence,
    supersedesId: partial.supersedesId ?? null,
    totalVehicleMiles: partial.totalVehicleMiles ?? null,
  };
}

beforeEach(() => {
  sequence = 0;
});

describe('buildRodsDay', () => {
  it('splits the day on the home terminal midnight, not on UTC midnight', () => {
    // 2026-03-10 is EDT (DST began 2026-03-08), so local midnight is 04:00 UTC. A record at
    // 03:00 UTC belongs to the PREVIOUS RODS day even though it is the same UTC date.
    const events = [
      event({ at: '2026-03-10T03:00:00Z', code: 4 }), // 2026-03-09 23:00 local — ON
      event({ at: '2026-03-10T06:00:00Z', code: 3 }), // 2026-03-10 02:00 local — D
      event({ at: '2026-03-10T10:00:00Z', code: 1 }), // 2026-03-10 06:00 local — OFF
    ];

    const day = buildRodsDay(events, TZ, '2026-03-10', new Date('2026-03-11T12:00:00Z'));

    expect(day.startAt.toISOString()).toBe('2026-03-10T04:00:00.000Z');
    expect(day.drivingSec).toBe(4 * 3600);
    // 04:00 UTC → 06:00 UTC is carried in from the previous day's ON record.
    expect(day.onDutySec).toBe(2 * 3600);
    expect(day.offDutySec).toBe(18 * 3600);
  });

  it('a day with no record at all is a full off-duty day', () => {
    const day = buildRodsDay([], TZ, '2026-06-01', new Date('2026-06-05T00:00:00Z'));
    expect(day.offDutySec).toBe(24 * 3600);
    expect(day.drivingSec).toBe(0);
    expect(day.segments).toHaveLength(0);
  });

  it('counts a 23-hour spring-forward day as 23 hours', () => {
    // 2026-03-08 is the US DST start: 02:00 local jumps to 03:00.
    const day = buildRodsDay([], TZ, '2026-03-08', new Date('2026-03-20T00:00:00Z'));
    expect(day.dayLengthSec).toBe(23 * 3600);
    expect(day.offDutySec).toBe(23 * 3600);
  });

  it('counts a 25-hour fall-back day as 25 hours', () => {
    const day = buildRodsDay([], TZ, '2026-11-01', new Date('2026-11-20T00:00:00Z'));
    expect(day.dayLengthSec).toBe(25 * 3600);
    expect(day.offDutySec).toBe(25 * 3600);
  });

  it('counts personal conveyance as off duty and yard move as on duty (§395.1(e))', () => {
    const events = [
      event({ at: '2026-06-01T12:00:00Z', code: 1 }), // OFF
      event({ at: '2026-06-01T13:00:00Z', code: 1, eventType: 3 }), // PC indication
      event({ at: '2026-06-01T14:00:00Z', code: 0, eventType: 3 }), // cleared
      event({ at: '2026-06-01T15:00:00Z', code: 4 }), // ON
    ];
    const day = buildRodsDay(events, TZ, '2026-06-01', new Date('2026-06-02T12:00:00Z'));
    expect(day.drivingSec).toBe(0);
    expect(day.onDutySec).toBe(13 * 3600); // 15:00Z until the next local midnight (04:00Z)
  });

  it('ignores a record retired by an "Inactive — Changed" marker', () => {
    const original = event({ at: '2026-06-01T12:00:00Z', code: 3 }); // driving, later corrected
    const marker = event({ at: '2026-06-01T12:00:00Z', code: 3, recordStatus: 2, supersedesId: original.id });
    const corrected = event({ at: '2026-06-01T12:00:00Z', code: 4, recordOrigin: 2 });
    const stop = event({ at: '2026-06-01T14:00:00Z', code: 1 });

    const day = buildRodsDay([original, marker, corrected, stop], TZ, '2026-06-01', new Date('2026-06-02T12:00:00Z'));

    expect(supersededEventIds([original, marker, corrected])).toEqual(new Set(['1']));
    expect(activeRecords([original, marker, corrected])).toHaveLength(1);
    expect(day.drivingSec).toBe(0);
    expect(day.onDutySec).toBe(2 * 3600);
    expect(day.hasEdits).toBe(true);
  });

  it('measures the distance from the odometer readings inside the day', () => {
    const events = [
      event({ at: '2026-06-01T12:00:00Z', code: 3, totalVehicleMiles: 100_000 }),
      event({ at: '2026-06-01T18:00:00Z', code: 1, totalVehicleMiles: 100_412 }),
    ];
    const day = buildRodsDay(events, TZ, '2026-06-01', new Date('2026-06-02T12:00:00Z'));
    expect(day.totalDistanceMi).toBe(412);
  });

  it('never counts time in the future', () => {
    const events = [event({ at: '2026-06-01T12:00:00Z', code: 3 })];
    const day = buildRodsDay(events, TZ, '2026-06-01', new Date('2026-06-01T15:00:00Z'));
    expect(day.drivingSec).toBe(3 * 3600);
  });
});

describe('statusInEffectAt / drivingIntervals', () => {
  it('reports the status in force immediately before an instant', () => {
    const events = [
      event({ at: '2026-06-01T12:00:00Z', code: 4 }),
      event({ at: '2026-06-01T14:00:00Z', code: 3 }),
    ];
    expect(statusInEffectAt(events, new Date('2026-06-01T13:00:00Z'))).toBe('ON');
    expect(statusInEffectAt(events, new Date('2026-06-01T11:00:00Z'))).toBeNull();
  });

  it('returns every active driving interval', () => {
    const events = [
      event({ at: '2026-06-01T12:00:00Z', code: 3 }),
      event({ at: '2026-06-01T14:00:00Z', code: 1 }),
      event({ at: '2026-06-01T16:00:00Z', code: 3 }),
      event({ at: '2026-06-01T17:00:00Z', code: 1 }),
    ];
    const intervals = drivingIntervals(events, new Date('2026-06-01T20:00:00Z'));
    expect(intervals).toHaveLength(2);
    expect(intervals[0].startAt.toISOString()).toBe('2026-06-01T12:00:00.000Z');
    expect(intervals[1].endAt.toISOString()).toBe('2026-06-01T17:00:00.000Z');
    expect(intervals.map((d) => d.open)).toEqual([false, false]);
  });

  it('B-073 — flags the driving segment still in force at now as open', () => {
    const events = [
      event({ at: '2026-06-01T12:00:00Z', code: 1 }),
      event({ at: '2026-06-01T14:00:00Z', code: 3 }),
    ];
    const intervals = drivingIntervals(events, new Date('2026-06-01T16:00:00Z'));
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ open: true });
    expect(intervals[0].endAt.toISOString()).toBe('2026-06-01T16:00:00.000Z');
  });
});

describe('B-059 — whole-second grid', () => {
  it('a finished day of millisecond-stamped records totals exactly 86 400 s', () => {
    const start = Date.parse('2026-06-01T04:00:00Z');
    const events: RodsEvent[] = [];
    // ~900 alternating ON / D records 96.1234 s apart: rounding each duration alone drifts ~30 s.
    for (let i = 0; i < 900; i += 1) {
      events.push(event({ at: new Date(start + 499 + Math.round(i * 96_123.4)).toISOString(), code: i % 2 ? 3 : 4 }));
    }
    const day = buildRodsDay(events, TZ, '2026-06-01', new Date('2026-06-05T00:00:00Z'));
    expect(day.offDutySec + day.sleeperSec + day.drivingSec + day.onDutySec).toBe(86400);
    expect(day.accountedSec).toBe(day.dayLengthSec);
    expect(day.segments.every((segment) => segment.durationSec > 0)).toBe(true);
  });

  it('records under 0.5 s apart (dropped by the segment builder) leave no hole in the day', () => {
    const start = Date.parse('2026-09-11T04:00:00Z');
    const events: RodsEvent[] = [];
    // 300 pairs: ON then OFF 0.3 s later, every 4 minutes — each ON segment rounds to 0 s and is dropped.
    for (let i = 0; i < 300; i += 1) {
      const t = start + 1_386 + i * 240_000;
      events.push(event({ at: new Date(t).toISOString(), code: 4 }));
      events.push(event({ at: new Date(t + 300).toISOString(), code: 1 }));
    }
    const day = buildRodsDay(events, TZ, '2026-09-11', new Date('2026-09-13T00:00:00Z'));
    expect(day.offDutySec + day.sleeperSec + day.drivingSec + day.onDutySec).toBe(86400);
    expect(day.accountedSec).toBe(86400);
    for (let i = 1; i < day.segments.length; i += 1) {
      expect(day.segments[i].startAt.getTime()).toBe(day.segments[i - 1].endAt.getTime());
    }
  });

  it('a sub-second status blip never breaks the day total', () => {
    const events = [
      event({ at: '2026-06-01T12:00:00.400Z', code: 4 }),
      event({ at: '2026-06-01T12:00:00.700Z', code: 3 }),
      event({ at: '2026-06-01T13:00:00.200Z', code: 1 }),
    ];
    const day = buildRodsDay(events, TZ, '2026-06-01', new Date('2026-06-05T00:00:00Z'));
    expect(day.offDutySec + day.sleeperSec + day.drivingSec + day.onDutySec).toBe(86400);
    // The 0.3 s ON blip may be coalesced by normalization; the hour of duty time is kept to the second.
    expect(day.drivingSec + day.onDutySec).toBeGreaterThanOrEqual(3599);
    expect(day.drivingSec + day.onDutySec).toBeLessThanOrEqual(3600);
  });
});
