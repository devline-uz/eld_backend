import { IftaReportGenerator, previousQuarter, quarterRange } from './ifta-report.generator';

describe('previousQuarter (TZ web/tz.md §20 — W-12 "vs prev." chip)', () => {
  it('steps back within a year', () => {
    expect(previousQuarter('2026-Q3')).toBe('2026-Q2');
  });

  it('rolls back across a year boundary', () => {
    expect(previousQuarter('2026-Q1')).toBe('2025-Q4');
  });
});

describe('quarterRange (TZ §15 IFTA quarter parsing)', () => {
  it('maps 2026-Q3 to Jul 1 .. Sep 30 UTC', () => {
    const { start, end } = quarterRange('2026-Q3');
    expect(start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(end.toISOString().slice(0, 10)).toBe('2026-09-30');
  });

  it('maps 2026-Q1 to Jan 1 .. Mar 31 UTC', () => {
    const { start, end } = quarterRange('2026-Q1');
    expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(end.toISOString().slice(0, 10)).toBe('2026-03-31');
  });
});

describe('IftaReportGenerator (TZ §15 — real IftaSegment/FuelPurchase aggregation)', () => {
  function buildPrisma() {
    return {
      iftaSegment: {
        groupBy: jest.fn(async () => [
          { jurisdiction: 'OH', _sum: { distanceMi: 800, fuelGal: 0 } },
          { jurisdiction: 'KY', _sum: { distanceMi: 200, fuelGal: 0 } },
        ]),
      },
      fuelPurchase: {
        groupBy: jest.fn(async () => [{ jurisdiction: 'OH', _sum: { gallons: 100 } }]),
      },
    };
  }

  it('computes fleet MPG and per-jurisdiction taxable/net-taxable gallons from real segment+purchase data', async () => {
    const prisma = buildPrisma();
    const gen = new IftaReportGenerator(prisma as never);
    const rows = await gen.rows({ quarter: '2026-Q3' });

    // fleet MPG = totalMiles / totalGallonsBurned = 1000 / 100 = 10
    expect(rows).toEqual([
      { jurisdiction: 'KY', milesDriven: 200, fuelPurchasedGal: '0.00', fleetMpg: '10.000', taxableGallons: '20.000', netTaxableGallons: '20.000' },
      { jurisdiction: 'OH', milesDriven: 800, fuelPurchasedGal: '100.00', fleetMpg: '10.000', taxableGallons: '80.000', netTaxableGallons: '-20.000' },
    ]);
  });

  it('streams the same rows as CSV with a matching row count', async () => {
    const prisma = buildPrisma();
    const gen = new IftaReportGenerator(prisma as never);
    const { stream, rowCount } = await gen.stream({ quarter: '2026-Q3' });
    expect(rowCount).toBe(2);
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text.split('\n')[0]).toBe('jurisdiction,milesDriven,fuelPurchasedGal,fleetMpg,taxableGallons,netTaxableGallons');
  });

  it('filters out jurisdictions with zero recorded miles', async () => {
    const prisma = {
      iftaSegment: { groupBy: jest.fn(async () => [{ jurisdiction: 'OH', _sum: { distanceMi: 0, fuelGal: 0 } }]) },
      fuelPurchase: { groupBy: jest.fn(async () => []) },
    };
    const gen = new IftaReportGenerator(prisma as never);
    const rows = await gen.rows({ quarter: '2026-Q3' });
    expect(rows).toEqual([]);
  });
});

describe('IftaReportGenerator.summary (gap B-46 — GET /reports/ifta/summary JSON)', () => {
  function buildPrisma(
    byQuarterGroupBy: Record<string, { segments: unknown[]; purchases: unknown[]; receiptCount?: number }>,
  ) {
    return {
      iftaSegment: {
        groupBy: jest.fn(async ({ where }: { where: { date: { gte: Date } } }) => {
          const key = where.date.gte.toISOString().slice(0, 7);
          return byQuarterGroupBy[key]?.segments ?? [];
        }),
        findMany: jest.fn(async () => [{ vehicleId: 'veh_1' }, { vehicleId: 'veh_2' }]),
      },
      fuelPurchase: {
        groupBy: jest.fn(async ({ where }: { where: { purchasedAt: { gte: Date } } }) => {
          const key = where.purchasedAt.gte.toISOString().slice(0, 7);
          return byQuarterGroupBy[key]?.purchases ?? [];
        }),
        count: jest.fn(async ({ where }: { where: { purchasedAt: { gte: Date } } }) => {
          const key = where.purchasedAt.gte.toISOString().slice(0, 7);
          const entry = byQuarterGroupBy[key];
          return entry?.receiptCount ?? entry?.purchases.length ?? 0;
        }),
      },
    };
  }

  it('computes KPIs/rows from real segment+purchase data and null-fills undeterminable fields', async () => {
    const prisma = buildPrisma({
      '2026-07': {
        segments: [
          { jurisdiction: 'OH', _sum: { distanceMi: 800 } },
          { jurisdiction: 'KY', _sum: { distanceMi: 200 } },
        ],
        purchases: [{ jurisdiction: 'OH', _sum: { gallons: 100 } }],
        receiptCount: 7,
      },
      '2026-04': {
        segments: [{ jurisdiction: 'OH', _sum: { distanceMi: 500 } }],
        purchases: [{ jurisdiction: 'OH', _sum: { gallons: 50 } }],
        receiptCount: 3,
      },
    });
    const gen = new IftaReportGenerator(prisma as never);
    const summary = await gen.summary({ quarter: '2026-Q3' });

    expect(summary.quarter).toBe('2026-Q3');
    expect(summary.unitCount).toBe(2);
    expect(summary.kpis).toEqual({
      totalMiles: 1000,
      taxableMiles: 1000,
      taxablePct: 100,
      fuelGal: 100,
      receiptCount: 7,
      fleetMpg: 10, // 1000 mi / 100 gal
      fleetMpgPrev: 10, // 500 mi / 50 gal in 2026-Q2
    });
    expect(summary.rows).toEqual([
      { jurisdiction: 'KY', totalMiles: 200, taxableMiles: 200, fuelGal: 0, mpg: 10, taxDueUsd: null },
      { jurisdiction: 'OH', totalMiles: 800, taxableMiles: 800, fuelGal: 100, mpg: 10, taxDueUsd: null },
    ]);
    expect(summary.totals).toEqual({ totalMiles: 1000, taxableMiles: 1000, fuelGal: 100, mpg: 10, taxDueUsd: null });
  });

  it('null-fills fuel/MPG/tax fields (never 0) when the quarter has no FuelPurchase rows at all', async () => {
    const prisma = buildPrisma({
      '2026-07': { segments: [{ jurisdiction: 'OH', _sum: { distanceMi: 300 } }], purchases: [] },
      '2026-04': { segments: [], purchases: [] },
    });
    const gen = new IftaReportGenerator(prisma as never);
    const summary = await gen.summary({ quarter: '2026-Q3' });

    expect(summary.kpis.fuelGal).toBeNull();
    expect(summary.kpis.receiptCount).toBeNull();
    expect(summary.kpis.fleetMpg).toBeNull();
    expect(summary.kpis.fleetMpgPrev).toBeNull();
    expect(summary.rows[0].fuelGal).toBeNull();
    expect(summary.rows[0].mpg).toBeNull();
    expect(summary.rows[0].taxDueUsd).toBeNull();
    expect(summary.totals.fuelGal).toBeNull();
    expect(summary.totals.mpg).toBeNull();
    expect(summary.totals.taxDueUsd).toBeNull();
  });

  it('taxablePct is null (not 0) when the quarter has no miles at all', async () => {
    const prisma = buildPrisma({ '2026-07': { segments: [], purchases: [] }, '2026-04': { segments: [], purchases: [] } });
    const gen = new IftaReportGenerator(prisma as never);
    const summary = await gen.summary({ quarter: '2026-Q3' });
    expect(summary.kpis.totalMiles).toBe(0);
    expect(summary.kpis.taxablePct).toBeNull();
    expect(summary.rows).toEqual([]);
  });
});
