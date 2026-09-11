import { IftaReportGenerator, quarterRange } from './ifta-report.generator';

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
