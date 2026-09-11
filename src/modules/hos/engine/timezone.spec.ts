/** TZ §8.3 step 0 — RODS day boundaries follow the driver's HOME TERMINAL timezone. */
import { addDays, dayDiff, dayEnd, dayKey, dayKeysBetween, dayLengthSec, dayStart, offsetMs, parseDayKey, wallClock, zonedToUtc } from './timezone';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const PHX = 'America/Phoenix';
const AK = 'America/Anchorage';
const HNL = 'Pacific/Honolulu';

describe('wallClock', () => {
  it('renders local fields for an EST instant', () => {
    expect(wallClock(NY, new Date('2025-01-15T17:30:45Z'))).toEqual({ year: 2025, month: 1, day: 15, hour: 12, minute: 30, second: 45 });
  });
  it('renders local midnight as hour 0, not 24', () => {
    expect(wallClock(NY, new Date('2025-01-15T05:00:00Z')).hour).toBe(0);
  });
  it('renders local fields for an EDT instant', () => {
    expect(wallClock(NY, new Date('2025-07-15T16:00:00Z'))).toEqual({ year: 2025, month: 7, day: 15, hour: 12, minute: 0, second: 0 });
  });
  it('rolls the calendar day back for a west-coast terminal', () => {
    expect(wallClock(LA, new Date('2025-01-15T05:00:00Z'))).toMatchObject({ day: 14, hour: 21 });
  });
  it('handles a zone that never observes DST', () => {
    expect(wallClock(PHX, new Date('2025-07-15T19:00:00Z')).hour).toBe(12);
  });
});

describe('offsetMs', () => {
  it.each([
    [NY, '2025-01-15T12:00:00Z', -5 * 3600_000],
    [NY, '2025-07-15T12:00:00Z', -4 * 3600_000],
    [LA, '2025-01-15T12:00:00Z', -8 * 3600_000],
    [PHX, '2025-07-15T12:00:00Z', -7 * 3600_000],
    [AK, '2025-01-15T12:00:00Z', -9 * 3600_000],
    [HNL, '2025-07-15T12:00:00Z', -10 * 3600_000],
    ['UTC', '2025-07-15T12:00:00Z', 0],
  ])('%s at %s', (zone, iso, expected) => {
    expect(offsetMs(zone, new Date(iso))).toBe(expected);
  });

  it('ignores sub-second components', () => {
    expect(offsetMs(NY, new Date('2025-01-15T12:00:00.750Z'))).toBe(-5 * 3600_000);
  });
});

describe('dayKey', () => {
  it('puts 23:59 local on the current day', () => {
    expect(dayKey(NY, new Date('2025-01-15T04:59:00Z'))).toBe('2025-01-14');
  });
  it('puts 00:00 local on the next day', () => {
    expect(dayKey(NY, new Date('2025-01-15T05:00:00Z'))).toBe('2025-01-15');
  });
  it('differs between home terminal and carrier timezone for the same instant', () => {
    const instant = new Date('2025-01-15T06:00:00Z');
    expect(dayKey(NY, instant)).toBe('2025-01-15');
    expect(dayKey(LA, instant)).toBe('2025-01-14');
  });
  it('pads single-digit months and days', () => {
    expect(dayKey('UTC', new Date('2025-03-05T00:00:00Z'))).toBe('2025-03-05');
  });
  it('crosses a year boundary', () => {
    expect(dayKey(NY, new Date('2026-01-01T04:00:00Z'))).toBe('2025-12-31');
  });
});

describe('dayStart / dayEnd', () => {
  it('starts a winter day at 05:00 UTC in New York', () => {
    expect(dayStart(NY, '2025-01-15').toISOString()).toBe('2025-01-15T05:00:00.000Z');
  });
  it('starts a summer day at 04:00 UTC in New York', () => {
    expect(dayStart(NY, '2025-07-15').toISOString()).toBe('2025-07-15T04:00:00.000Z');
  });
  it('ends a day at the next local midnight', () => {
    expect(dayEnd(NY, '2025-01-15').toISOString()).toBe('2025-01-16T05:00:00.000Z');
  });
  it('resolves the spring-forward day start before the transition', () => {
    expect(dayStart(NY, '2025-03-09').toISOString()).toBe('2025-03-09T05:00:00.000Z');
  });
  it('resolves the fall-back day start', () => {
    expect(dayStart(NY, '2025-11-02').toISOString()).toBe('2025-11-02T04:00:00.000Z');
  });
  it('is stable across a leap day', () => {
    expect(dayStart('UTC', '2024-02-29').toISOString()).toBe('2024-02-29T00:00:00.000Z');
  });
});

describe('dayLengthSec — DST', () => {
  it('spring forward is a 23-hour day', () => {
    expect(dayLengthSec(NY, '2025-03-09')).toBe(23 * 3600);
  });
  it('fall back is a 25-hour day', () => {
    expect(dayLengthSec(NY, '2025-11-02')).toBe(25 * 3600);
  });
  it('an ordinary day is 24 hours', () => {
    expect(dayLengthSec(NY, '2025-06-01')).toBe(24 * 3600);
  });
  it('Arizona has no 23-hour day', () => {
    expect(dayLengthSec(PHX, '2025-03-09')).toBe(24 * 3600);
  });
  it('Alaska also gains an hour in November', () => {
    expect(dayLengthSec(AK, '2025-11-02')).toBe(25 * 3600);
  });
  it('the day before spring forward is still 24 hours', () => {
    expect(dayLengthSec(NY, '2025-03-08')).toBe(24 * 3600);
  });
});

describe('addDays / dayDiff / parseDayKey', () => {
  it('adds across a month boundary', () => {
    expect(addDays('2025-01-31', 1)).toBe('2025-02-01');
  });
  it('subtracts across a year boundary', () => {
    expect(addDays('2025-01-01', -1)).toBe('2024-12-31');
  });
  it('adds across a leap day', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });
  it('is unaffected by DST', () => {
    expect(addDays('2025-03-08', 1)).toBe('2025-03-09');
  });
  it('measures whole days between keys', () => {
    expect(dayDiff('2025-01-15', '2025-01-08')).toBe(7);
  });
  it('measures negative differences', () => {
    expect(dayDiff('2025-01-08', '2025-01-15')).toBe(-7);
  });
  it('parses a key', () => {
    expect(parseDayKey('2025-03-09')).toEqual({ year: 2025, month: 3, day: 9 });
  });
});

describe('dayKeysBetween', () => {
  it('lists every day inclusive', () => {
    expect(dayKeysBetween(NY, new Date('2025-01-14T12:00:00Z'), new Date('2025-01-16T12:00:00Z'))).toEqual(['2025-01-14', '2025-01-15', '2025-01-16']);
  });
  it('returns a single day when both instants share it', () => {
    expect(dayKeysBetween(NY, new Date('2025-01-14T12:00:00Z'), new Date('2025-01-14T13:00:00Z'))).toEqual(['2025-01-14']);
  });
  it('returns nothing when the range is inverted', () => {
    expect(dayKeysBetween(NY, new Date('2025-01-16T12:00:00Z'), new Date('2025-01-14T12:00:00Z'))).toEqual([]);
  });
  it('spans a DST transition', () => {
    expect(dayKeysBetween(NY, new Date('2025-03-08T12:00:00Z'), new Date('2025-03-10T12:00:00Z'))).toEqual(['2025-03-08', '2025-03-09', '2025-03-10']);
  });
  it('stops at the 4000-day guard', () => {
    const keys = dayKeysBetween('UTC', new Date('2000-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
    expect(keys).toHaveLength(4000);
  });
});

describe('zonedToUtc', () => {
  it('round-trips a winter local time', () => {
    expect(zonedToUtc(NY, { year: 2025, month: 1, day: 15, hour: 12, minute: 0, second: 0 }).toISOString()).toBe('2025-01-15T17:00:00.000Z');
  });
  it('round-trips a summer local time', () => {
    expect(zonedToUtc(NY, { year: 2025, month: 7, day: 15, hour: 12, minute: 0, second: 0 }).toISOString()).toBe('2025-07-15T16:00:00.000Z');
  });
  it('still returns a real, deterministic instant for a local time inside the DST gap', () => {
    // 02:30 local never happens on 2025-03-09. Both engines must agree on SOMETHING here, so
    // the two-pass offset search is specified: it lands on the instant one hour earlier.
    expect(zonedToUtc(NY, { year: 2025, month: 3, day: 9, hour: 2, minute: 30, second: 0 }).toISOString()).toBe('2025-03-09T06:30:00.000Z');
  });
  it('resolves the ambiguous fall-back local time to the first occurrence', () => {
    expect(zonedToUtc(NY, { year: 2025, month: 11, day: 2, hour: 1, minute: 30, second: 0 }).toISOString()).toBe('2025-11-02T05:30:00.000Z');
  });
});
