import { DateTime } from 'luxon';
import { dateKey, groupDrivingDays } from './fleet.helpers';

const TZ = 'America/New_York';

describe('fleet mock helpers — groupDrivingDays', () => {
  it('returns an empty array for no events', () => {
    expect(groupDrivingDays([], TZ)).toEqual([]);
  });

  it('groups multiple driving events on the same home-terminal calendar day into one span', () => {
    const events = [
      { vehicleId: 'v1', eventDateTime: new Date('2026-06-01T13:00:00Z') }, // 09:00 America/New_York
      { vehicleId: 'v1', eventDateTime: new Date('2026-06-01T15:30:00Z') }, // 11:30
      { vehicleId: 'v1', eventDateTime: new Date('2026-06-01T20:00:00Z') }, // 16:00
    ];
    const spans = groupDrivingDays(events, TZ);
    expect(spans).toHaveLength(1);
    expect(spans[0].day).toBe('2026-06-01');
    expect(spans[0].first).toEqual(events[0].eventDateTime);
    expect(spans[0].last).toEqual(events[2].eventDateTime);
    expect(spans[0].vehicleId).toBe('v1');
  });

  it('splits events into separate days using the driver home-terminal timezone, not UTC', () => {
    // 23:30 America/Los_Angeles on 2026-06-01 is 06:30 UTC on 2026-06-02 — must land on the
    // *local* day, since the RODS day boundary follows homeTerminalTimezone (tz.md), never UTC.
    const tz = 'America/Los_Angeles';
    const events = [
      { vehicleId: 'v1', eventDateTime: DateTime.fromObject({ year: 2026, month: 6, day: 1, hour: 23, minute: 30 }, { zone: tz }).toJSDate() },
      { vehicleId: 'v1', eventDateTime: DateTime.fromObject({ year: 2026, month: 6, day: 2, hour: 1, minute: 0 }, { zone: tz }).toJSDate() },
    ];
    const spans = groupDrivingDays(events, tz);
    expect(spans.map((s) => s.day)).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('sorts spans ascending by first event and fills a missing vehicleId from a later event', () => {
    const events = [
      { vehicleId: null, eventDateTime: new Date('2026-06-03T13:00:00Z') },
      { vehicleId: 'v2', eventDateTime: new Date('2026-06-03T14:00:00Z') },
      { vehicleId: 'v1', eventDateTime: new Date('2026-06-01T13:00:00Z') },
    ];
    const spans = groupDrivingDays(events, TZ);
    expect(spans.map((s) => s.day)).toEqual(['2026-06-01', '2026-06-03']);
    expect(spans[1].vehicleId).toBe('v2');
  });

  it('dateKey formats in yyyy-LL-dd', () => {
    expect(dateKey(DateTime.fromObject({ year: 2026, month: 3, day: 14 }))).toBe('2026-03-14');
  });
});
