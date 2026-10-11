import {
  dateKeyToDbDate,
  dbDateToKey,
  fleetScore,
  latestCompleteDay,
  periodEndingOn,
  periodInstants,
  previousPeriod,
  rankDrivers,
  scoreTrend,
} from './scorecard';

describe('scorecard period helpers (D-133)', () => {
  it('a period is 30 inclusive days; the previous one is the 30 days before it', () => {
    const p = periodEndingOn('2026-10-10');
    expect(p).toEqual({ startKey: '2026-09-11', endKey: '2026-10-10' });
    expect(previousPeriod(p)).toEqual({ startKey: '2026-08-12', endKey: '2026-09-10' });
  });

  it('the period ends on the newest day complete in EVERY home-terminal zone', () => {
    // 10:30 UTC on Oct 11: Oct 10 is over everywhere, including Hawaii (00:30 local).
    expect(latestCompleteDay(new Date('2026-10-11T10:30:00Z'), ['America/New_York', 'Pacific/Honolulu'])).toBe('2026-10-10');
    // 03:00 UTC on Oct 11: still Oct 10 in New York (23:00) -> only Oct 9 is complete there.
    expect(latestCompleteDay(new Date('2026-10-11T03:00:00Z'), ['America/New_York'])).toBe('2026-10-09');
    expect(latestCompleteDay(new Date('2026-10-11T03:00:00Z'), ['Europe/Berlin', 'America/New_York'])).toBe('2026-10-09');
    expect(latestCompleteDay(new Date('2026-10-11T03:00:00Z'), [])).toBe('2026-10-10'); // UTC fallback
  });

  it('event instants are bucketed by the driver home-terminal midnights, DST-aware', () => {
    const p = periodEndingOn('2026-11-02'); // US DST ends Nov 1 2026
    const ny = periodInstants('America/New_York', p);
    expect(ny.from.toISOString()).toBe('2026-10-04T04:00:00.000Z'); // EDT midnight
    expect(ny.to.toISOString()).toBe('2026-11-03T05:00:00.000Z'); // EST midnight after the last day
    const chi = periodInstants('America/Chicago', p);
    expect(chi.from.toISOString()).toBe('2026-10-04T05:00:00.000Z');
  });

  it('@db.Date round-trips as UTC midnight, never host-local (B-056)', () => {
    expect(dateKeyToDbDate('2026-09-11').toISOString()).toBe('2026-09-11T00:00:00.000Z');
    expect(dbDateToKey(new Date('2026-09-11T00:00:00.000Z'))).toBe('2026-09-11');
  });
});

describe('rankDrivers (D-133)', () => {
  it('#1 = best score; ties by more miles, then name; unscored get no rank', () => {
    const ranks = rankDrivers([
      { driverId: 'd1', score: 90, milesDriven: 1000, name: 'Brown, A' },
      { driverId: 'd2', score: 95, milesDriven: 200, name: 'Zed, Z' },
      { driverId: 'd3', score: 90, milesDriven: 3000, name: 'Young, Y' },
      { driverId: 'd4', score: 90, milesDriven: 1000, name: 'Adams, B' },
      { driverId: 'd5', score: null, milesDriven: 50, name: 'Aaron, A' },
    ]);
    expect([...ranks]).toEqual([
      ['d2', 1],
      ['d3', 2],
      ['d4', 3],
      ['d1', 4],
    ]);
    expect(ranks.has('d5')).toBe(false);
  });
});

describe('fleetScore / scoreTrend (D-133)', () => {
  it('is the mile-weighted mean of scored drivers only', () => {
    expect(
      fleetScore([
        { score: 100, milesDriven: 3000 },
        { score: 60, milesDriven: 1000 },
        { score: null, milesDriven: 90 },
      ]),
    ).toBe(90);
  });

  it('is null when nobody is scored', () => {
    expect(fleetScore([{ score: null, milesDriven: 50 }])).toBeNull();
    expect(fleetScore([])).toBeNull();
  });

  it('trend = current − previous, null when either side is missing', () => {
    expect(scoreTrend(90, 85)).toBe(5);
    expect(scoreTrend(80, 85)).toBe(-5);
    expect(scoreTrend(null, 85)).toBeNull();
    expect(scoreTrend(90, null)).toBeNull();
  });
});
