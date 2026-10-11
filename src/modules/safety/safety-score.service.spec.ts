import type { SafetyRepository } from './safety.repository';
import { SafetyScoreService } from './safety-score.service';

const drivers = [
  { id: 'd_ny', firstName: 'Ann', lastName: 'Adams', status: 'ACTIVE', homeTerminalTimezone: 'America/New_York' },
  { id: 'd_chi', firstName: 'Bob', lastName: 'Brown', status: 'ACTIVE', homeTerminalTimezone: 'America/Chicago' },
  { id: 'd_idle', firstName: 'Cy', lastName: 'Cole', status: 'ACTIVE', homeTerminalTimezone: 'America/New_York' },
  { id: 'd_gone', firstName: 'Di', lastName: 'Dee', status: 'INACTIVE', homeTerminalTimezone: 'America/New_York' },
];

function build() {
  const repo = {
    scoringDrivers: jest.fn(async () => drivers),
    milesByDriver: jest.fn(async () => new Map([['d_ny', 2000], ['d_chi', 1000], ['d_idle', 40]])),
    hosViolationsByDriver: jest.fn(async () => new Map([['d_chi', 1]])),
    eventCountsForDrivers: jest.fn(async (ids: string[]) =>
      ids.includes('d_ny')
        ? [
            { driverId: 'd_ny', type: 'HARSH_BRAKING', severity: 5, _count: { _all: 1 } },
            { driverId: 'd_ny', type: 'HARSH_TURN', severity: 2, _count: { _all: 2 } },
            { driverId: 'd_ny', type: 'SEATBELT', severity: 1, _count: { _all: 1 } },
          ]
        : [{ driverId: 'd_chi', type: 'SPEEDING', severity: 3, _count: { _all: 2 } }],
    ),
    replacePeriodScores: jest.fn(async () => undefined),
  };
  return { repo, service: new SafetyScoreService(repo as unknown as SafetyRepository) };
}

describe('SafetyScoreService (D-133)', () => {
  it('scores the current and the previous rolling period, using per-zone event windows', async () => {
    const { repo, service } = build();
    const result = await service.run(new Date('2026-10-11T10:30:00Z'));

    expect(result.current).toEqual({ periodStart: '2026-09-11', periodEnd: '2026-10-10', drivers: 3, scored: 2, unscored: 1 });
    expect(result.previous).toEqual(expect.objectContaining({ periodStart: '2026-08-12', periodEnd: '2026-09-10' }));
    // Day-keyed tables are filtered by UTC-midnight @db.Date values (B-056).
    expect(repo.milesByDriver).toHaveBeenCalledWith(new Date('2026-09-11T00:00:00.000Z'), new Date('2026-10-10T00:00:00.000Z'));
    // One event query per zone, each with its own local-midnight boundaries.
    const calls = repo.eventCountsForDrivers.mock.calls as unknown as Array<[string[], Date, Date]>;
    const nyCall = calls.find(([ids, from]) => ids.includes('d_ny') && from.toISOString() === '2026-09-11T04:00:00.000Z');
    const chiCall = calls.find(([ids, from]) => ids.includes('d_chi') && from.toISOString() === '2026-09-11T05:00:00.000Z');
    expect(nyCall?.[2].toISOString()).toBe('2026-10-11T04:00:00.000Z');
    expect(chiCall).toBeDefined();
  });

  it('writes formula scores, ranks and "Not enough miles" rows', async () => {
    const { repo, service } = build();
    await service.run(new Date('2026-10-11T10:30:00Z'));
    const [start, end, rows] = (repo.replacePeriodScores.mock.calls as unknown as Array<[Date, Date, Array<Record<string, unknown>>]>)[1];
    expect(start.toISOString()).toBe('2026-09-11T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    const byId: Record<string, Record<string, unknown> | undefined> = Object.fromEntries(rows.map((r) => [String(r.driverId), r]));
    // d_ny: harsh 1×2×4 + 2×2×1 = 12, seatbelt 3 -> 15 / 2 = 7.5 -> round(92.5) = 93
    expect(byId.d_ny).toEqual(expect.objectContaining({ score: 93, scored: true, harshCount: 3, seatbeltCount: 1, milesDriven: 2000, rank: 1 }));
    // d_chi: speeding 2×1.5 + 1 HOS × 5 = 8 / 1 = 92
    expect(byId.d_chi).toEqual(expect.objectContaining({ score: 92, scored: true, speedingCount: 2, violationCount: 1, rank: 2 }));
    expect(byId.d_idle).toEqual(expect.objectContaining({ score: 0, scored: false, rank: null, milesDriven: 40 }));
    // Inactive driver with no activity in the period gets no row at all.
    expect(byId.d_gone).toBeUndefined();
  });
});
