/** TZ §8.3 step 0 — RODS day boundaries follow the driver's HOME TERMINAL timezone. */
import { addDays, dayDiff, dayEnd, dayKey, dayKeysBetween, dayLengthSec, dayStart, offsetMs, parseDayKey, wallClock, wallClockFromParts, zonedToUtc } from './timezone';

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
  it('resolves a local time inside the DST gap FORWARD (B-041)', () => {
    // 02:30 local never happens on 2025-03-09. Both engines resolve the gap forward, past the
    // transition (02:30 EST would be 07:30Z, and the clock is already 03:30 EDT there), so a
    // day boundary that falls in a gap can never land on the previous local day.
    expect(zonedToUtc(NY, { year: 2025, month: 3, day: 9, hour: 2, minute: 30, second: 0 }).toISOString()).toBe('2025-03-09T07:30:00.000Z');
  });
  it('resolves the ambiguous fall-back local time to the first occurrence', () => {
    expect(zonedToUtc(NY, { year: 2025, month: 11, day: 2, hour: 1, minute: 30, second: 0 }).toISOString()).toBe('2025-11-02T05:30:00.000Z');
  });
});

describe('wallClockFromParts — defensive fallback for an incomplete parts list', () => {
  const parts = (fields: Record<string, string>): Intl.DateTimeFormatPart[] =>
    Object.entries(fields).map(([type, value]) => ({ type, value }) as Intl.DateTimeFormatPart);

  it('reads a complete parts list', () => {
    expect(wallClockFromParts(parts({ year: '2025', month: '03', day: '09', hour: '02', minute: '30', second: '05' })))
      .toEqual({ year: 2025, month: 3, day: 9, hour: 2, minute: 30, second: 5 });
  });

  it('defaults a missing field to 0 instead of letting NaN reach the day key', () => {
    expect(wallClockFromParts(parts({ year: '2025', month: '03', day: '09' })))
      .toEqual({ year: 2025, month: 3, day: 9, hour: 0, minute: 0, second: 0 });
  });

  it('defaults every field of an empty parts list', () => {
    expect(wallClockFromParts([])).toEqual({ year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 });
  });

  it('normalises an ICU build that renders midnight as hour 24', () => {
    expect(wallClockFromParts(parts({ year: '2025', month: '03', day: '09', hour: '24', minute: '00', second: '00' })).hour).toBe(0);
  });
});

/**
 * Regression for the spring-forward gap. In zones whose DST transition is AT midnight the RODS
 * day boundary itself is a non-existent local time; resolving it backwards made `dayStart`
 * disagree with `dayKey` and cost the driver the hour before the transition.
 */
describe('zonedToUtc — non-existent local times resolve forward', () => {
  const HAV = 'America/Havana';   // transitions at 00:00 local (2026-03-08)
  const SCL = 'America/Santiago'; // transitions at 24:00 local (2026-09-06)
  const CHATHAM = 'Pacific/Chatham'; // +12:45/+13:45 — forces the second pass to correct

  it('maps Havana midnight of the transition day to the instant just after the gap', () => {
    // 2026-03-08 00:00 CST does not exist; the clock goes 23:59:59 → 01:00:00 CDT.
    expect(zonedToUtc(HAV, { year: 2026, month: 3, day: 8, hour: 0, minute: 0, second: 0 }).toISOString())
      .toBe('2026-03-08T05:00:00.000Z');
  });

  it('keeps dayStart consistent with dayKey in a midnight-transition zone', () => {
    for (const key of ['2026-03-07', '2026-03-08', '2026-03-09']) {
      expect(dayKey(HAV, dayStart(HAV, key))).toBe(key);
    }
    for (const key of ['2026-09-05', '2026-09-06', '2026-09-07']) {
      expect(dayKey(SCL, dayStart(SCL, key))).toBe(key);
    }
  });

  it('gives the Havana transition day 23 h and the day before it a full 24 h', () => {
    expect(dayLengthSec(HAV, '2026-03-07')).toBe(86_400);
    expect(dayLengthSec(HAV, '2026-03-08')).toBe(82_800);
  });

  it('gives the Santiago transition day 23 h', () => {
    expect(dayLengthSec(SCL, '2026-09-06')).toBe(82_800);
  });

  it('resolves a 02:30 that does not exist forward, never backward', () => {
    // America/New_York 2026-03-08: 02:00 EST → 03:00 EDT, so 02:30 is in the gap.
    const resolved = zonedToUtc(NY, { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 });
    expect(resolved.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(wallClock(NY, resolved)).toMatchObject({ day: 8, hour: 3, minute: 30 });
  });

  it('still returns the first occurrence of an ambiguous fall-back local time', () => {
    // 2026-11-01 01:30 happens twice in New York; the earlier (EDT) instant is the answer.
    expect(zonedToUtc(NY, { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }).toISOString())
      .toBe('2026-11-01T05:30:00.000Z');
  });

  it('accepts a second-pass correction when the local time does exist', () => {
    // Chatham's 12:45/13:45 offsets put the naive guess on the far side of the transition, so
    // the two passes disagree even though 2026-09-26 20:00 is a perfectly real local time.
    const resolved = zonedToUtc(CHATHAM, { year: 2026, month: 9, day: 26, hour: 20, minute: 0, second: 0 });
    expect(resolved.toISOString()).toBe('2026-09-26T07:15:00.000Z');
    expect(wallClock(CHATHAM, resolved)).toMatchObject({ day: 26, hour: 20, minute: 0 });
  });

  it('keeps every US home-terminal zone round-tripping across both transitions', () => {
    for (const zone of [NY, LA, PHX, AK, HNL, 'America/Chicago', 'America/Denver']) {
      for (const key of ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']) {
        expect(dayKey(zone, dayStart(zone, key))).toBe(key);
        expect(dayEnd(zone, key).getTime()).toBe(dayStart(zone, addDays(key, 1)).getTime());
      }
    }
  });

  it('reports a calendar date the zone skipped entirely as a zero-length day', () => {
    // Pacific/Apia jumped from 2011-12-29 straight to 2011-12-31: 12-30 never happened.
    expect(dayLengthSec('Pacific/Apia', '2011-12-30')).toBe(0);
    expect(dayLengthSec('Pacific/Apia', '2011-12-29')).toBe(86_400);
    expect(dayKey('Pacific/Apia', dayStart('Pacific/Apia', '2011-12-29'))).toBe('2011-12-29');
  });
});
