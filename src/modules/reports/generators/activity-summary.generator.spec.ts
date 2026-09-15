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

    const result = await generator.summary({ from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', page: 1, limit: 25 });

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

    const result = await generator.summary({ from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', page: 1, limit: 25 });

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

    const result = await generator.summary({ from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', page: 2, limit: 25 });

    expect(result.total).toBe(55);
    expect(result.totalPages).toBe(3); // ceil(55 / 25)
    expect(result.page).toBe(2);
    expect(result.limit).toBe(25);
  });
});
