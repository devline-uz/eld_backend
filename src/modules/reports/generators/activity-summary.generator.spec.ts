import { ActivitySummaryGenerator, previousPeriod } from './activity-summary.generator';

describe('previousPeriod() — same-length window immediately before `from` (gap B-46)', () => {
  it('an 8-day range shifts back by exactly 8 days with no overlap', () => {
    expect(previousPeriod('2026-09-01', '2026-09-08')).toEqual({ from: '2026-08-24', to: '2026-08-31' });
  });

  it('a single day shifts back by one day', () => {
    expect(previousPeriod('2026-09-14', '2026-09-14')).toEqual({ from: '2026-09-13', to: '2026-09-13' });
  });

  it('crosses a month/year boundary correctly (RODS day boundaries are date-only, not TZ math)', () => {
    expect(previousPeriod('2026-01-01', '2026-01-05')).toEqual({ from: '2025-12-27', to: '2025-12-31' });
  });
});

describe('ActivitySummaryGenerator (gap B-46)', () => {
  function buildPrisma(pageRows: unknown[], currentTotals: unknown[], previousTotals: unknown[]) {
    const calls: string[] = [];
    const $queryRaw = jest.fn(async (query: { strings: string[] }) => {
      const sql = query.strings.join('');
      calls.push(sql);
      if (sql.includes('WITH agg AS')) return pageRows;
      // fetchTotals is called twice: current period first, then previous period.
      if (calls.filter((s) => !s.includes('WITH agg AS')).length === 1) return currentTotals;
      return previousTotals;
    });
    return { $queryRaw: $queryRaw as unknown as (...args: unknown[]) => Promise<unknown> };
  }

  it('aggregates a page, computes a driving % delta and a violations count delta against the previous period', async () => {
    const prisma = buildPrisma(
      [
        {
          driverId: 'drv_1',
          name: 'Doe, John',
          days: 8n,
          off_sec: 100n,
          sb_sec: 0n,
          driving_sec: 39600n,
          on_sec: 7200n,
          distance_mi: 512n,
          violations: 1n,
          certified_days: 8n,
          total: 1n,
        },
      ],
      [{ driving_sec: 39600n, on_sec: 7200n, distance_mi: 512n, violations: 1n, has_data: true }],
      [{ driving_sec: 36000n, on_sec: 7000n, distance_mi: 480n, violations: 3n, has_data: true }],
    );
    const generator = new ActivitySummaryGenerator(prisma as never);

    const result = await generator.summary({
      from: '2026-09-01',
      to: '2026-09-08',
      sort: 'name:asc',
      groupBy: 'driver',
      page: 1,
      limit: 25,
    });

    expect(result.items).toEqual([
      {
        driverId: 'drv_1',
        name: 'Doe, John',
        days: 8,
        offSec: 100,
        sbSec: 0,
        drivingSec: 39600,
        onSec: 7200,
        distanceMi: 512,
        violations: 1,
        certifiedDays: 8,
      },
    ]);
    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
    // (39600 - 36000) / 36000 * 100 = 10.0
    expect(result.kpis.drivingDeltaPct).toBe(10);
    // 1 - 3 = -2
    expect(result.kpis.violationsDelta).toBe(-2);
    expect(result.kpis.drivingSec).toBe(39600);
    expect(result.kpis.onDutySec).toBe(7200);
    expect(result.kpis.distanceMi).toBe(512);
    expect(result.kpis.violations).toBe(1);
  });

  it('never fabricates a delta: null (not 0) when the previous period has no DailyLog data at all', async () => {
    const prisma = buildPrisma(
      [],
      [{ driving_sec: 39600n, on_sec: 7200n, distance_mi: 512n, violations: 2n, has_data: true }],
      [{ driving_sec: 0n, on_sec: 0n, distance_mi: 0n, violations: 0n, has_data: false }],
    );
    const generator = new ActivitySummaryGenerator(prisma as never);

    const result = await generator.summary({ from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', groupBy: 'driver', page: 1, limit: 25 });

    expect(result.kpis.drivingDeltaPct).toBeNull();
    expect(result.kpis.violationsDelta).toBeNull();
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(1);
  });

  it('never fabricates a percentage delta when the previous period exists but drove 0 seconds (division by zero)', async () => {
    const prisma = buildPrisma(
      [],
      [{ driving_sec: 39600n, on_sec: 7200n, distance_mi: 512n, violations: 0n, has_data: true }],
      [{ driving_sec: 0n, on_sec: 0n, distance_mi: 0n, violations: 0n, has_data: true }],
    );
    const generator = new ActivitySummaryGenerator(prisma as never);

    const result = await generator.summary({ from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', groupBy: 'driver', page: 1, limit: 25 });

    expect(result.kpis.drivingDeltaPct).toBeNull();
    // previous had real data (0 violations), so the delta is a real number, not null.
    expect(result.kpis.violationsDelta).toBe(0);
  });

  it('computes totalPages from the window total, independent of the current page size', async () => {
    const prisma = buildPrisma(
      [
        {
          driverId: 'drv_1',
          name: 'A, A',
          days: 1n,
          off_sec: 0n,
          sb_sec: 0n,
          driving_sec: 0n,
          on_sec: 0n,
          distance_mi: 0n,
          violations: 0n,
          certified_days: 0n,
          total: 55n,
        },
      ],
      [{ driving_sec: 0n, on_sec: 0n, distance_mi: 0n, violations: 0n, has_data: true }],
      [{ driving_sec: 0n, on_sec: 0n, distance_mi: 0n, violations: 0n, has_data: false }],
    );
    const generator = new ActivitySummaryGenerator(prisma as never);

    const result = await generator.summary({ from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', groupBy: 'driver', page: 2, limit: 25 });

    expect(result.total).toBe(55);
    expect(result.totalPages).toBe(3); // ceil(55 / 25)
    expect(result.page).toBe(2);
    expect(result.limit).toBe(25);
  });

  it('groupBy=vehicleGroup rolls rows up by the assigned unit\'s group; ungrouped comes back as `groupId: null` / "Ungrouped"', async () => {
    const totals = [{ driving_sec: 0n, on_sec: 0n, distance_mi: 0n, violations: 0n, has_data: true }];
    const prisma = buildPrisma(
      [
        { groupId: 'vg_1', name_sort: 'Midwest', drivers: 3n, days: 20n, off_sec: 1n, sb_sec: 2n, driving_sec: 3n, on_sec: 4n, distance_mi: 5n, violations: 1n, certified_days: 18n, total: 2n },
        { groupId: null, name_sort: null, drivers: 1n, days: 4n, off_sec: 0n, sb_sec: 0n, driving_sec: 0n, on_sec: 0n, distance_mi: 0n, violations: 0n, certified_days: 4n, total: 2n },
      ],
      totals,
      totals,
    );
    const generator = new ActivitySummaryGenerator(prisma as never);

    const result = await generator.summary({ from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', groupBy: 'vehicleGroup', page: 1, limit: 25 });

    expect(result.groupBy).toBe('vehicleGroup');
    expect(result.total).toBe(2);
    expect(result.items).toEqual([
      { groupId: 'vg_1', name: 'Midwest', drivers: 3, days: 20, offSec: 1, sbSec: 2, drivingSec: 3, onSec: 4, distanceMi: 5, violations: 1, certifiedDays: 18 },
      { groupId: null, name: 'Ungrouped', drivers: 1, days: 4, offSec: 0, sbSec: 0, drivingSec: 0, onSec: 0, distanceMi: 0, violations: 0, certifiedDays: 4 },
    ]);
    const pageSql = (prisma.$queryRaw as unknown as jest.Mock).mock.calls
      .map(([q]: [{ strings: string[] }]) => q.strings.join(''))
      .find((sql: string) => sql.includes('WITH agg AS'));
    expect(pageSql).toContain('LEFT JOIN "VehicleGroup" g');
    expect(pageSql).toContain('GROUP BY g."id", g."name"');
  });

  it('vehicleGroupId filters drivers by their assigned unit\'s group in both the page and the KPI totals (bound, never interpolated)', async () => {
    const totals = [{ driving_sec: 0n, on_sec: 0n, distance_mi: 0n, violations: 0n, has_data: false }];
    const prisma = buildPrisma([], totals, totals);
    const generator = new ActivitySummaryGenerator(prisma as never);
    const groupId = '11111111-1111-4111-8111-111111111111';

    await generator.summary({ from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', groupBy: 'driver', vehicleGroupId: groupId, page: 1, limit: 25 });

    const calls = (prisma.$queryRaw as unknown as jest.Mock).mock.calls as Array<[{ strings: string[]; values: unknown[] }]>;
    expect(calls).toHaveLength(3);
    for (const [q] of calls) {
      expect(q.strings.join('')).toContain('fv."groupId" =');
      expect(q.strings.join('')).not.toContain(groupId);
      expect(q.values).toContain(groupId);
    }
  });
});
