import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PrismaService } from '../../../core/prisma/prisma.service';
import type { IftaReportParamsDto } from '../dto/reports.dto';
import { csvFromRows } from '../lib/csv-stream';

export interface IftaReportRow {
  jurisdiction: string;
  milesDriven: number;
  fuelPurchasedGal: string;
  fleetMpg: string;
  taxableGallons: string;
  netTaxableGallons: string;
}

/** `YYYY-Q#` -> UTC [start, end] of that quarter, inclusive. */
export function quarterRange(quarter: string): { start: Date; end: Date } {
  const [yearStr, qStr] = quarter.split('-Q');
  const year = Number(yearStr);
  const q = Number(qStr);
  const startMonth = (q - 1) * 3 + 1;
  const start = DateTime.utc(year, startMonth, 1).startOf('day');
  const end = start.plus({ months: 3 }).minus({ days: 1 }).endOf('day');
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/**
 * TZ §15 — IFTA quarterly return, computed from `IftaSegment` (telemetry-derived
 * per-jurisdiction miles) and `FuelPurchase` (tax-paid gallons), per the standard IFTA
 * formula: fleet MPG = total miles / total gallons burned; taxable gallons per jurisdiction
 * = miles in that jurisdiction / fleet MPG; net taxable gallons = taxable − tax-paid gallons
 * purchased in that jurisdiction. This is real, persisted segment/purchase data — not an
 * estimate synthesized at report time (see D-041 in decisions.md).
 */
@Injectable()
export class IftaReportGenerator {
  constructor(private readonly prisma: PrismaService) {}

  async rows(params: IftaReportParamsDto): Promise<IftaReportRow[]> {
    const { start, end } = quarterRange(params.quarter);
    const vehicleFilter = params.vehicleId ? { vehicleId: params.vehicleId } : {};

    const segments = await this.prisma.iftaSegment.groupBy({
      by: ['jurisdiction'],
      where: { ...vehicleFilter, date: { gte: start, lte: end } },
      _sum: { distanceMi: true, fuelGal: true },
    });
    const purchases = await this.prisma.fuelPurchase.groupBy({
      by: ['jurisdiction'],
      where: { ...vehicleFilter, purchasedAt: { gte: start, lte: end } },
      _sum: { gallons: true },
    });
    const purchasedByJurisdiction = new Map(
      purchases.map((p) => [p.jurisdiction, Number(p._sum.gallons ?? 0)]),
    );

    const totalMiles = segments.reduce((sum, s) => sum + (s._sum.distanceMi ?? 0), 0);
    const totalGallonsBurned = purchases.reduce((sum, p) => sum + Number(p._sum.gallons ?? 0), 0);
    const fleetMpg = totalGallonsBurned > 0 ? totalMiles / totalGallonsBurned : 0;

    return segments
      .filter((s) => (s._sum.distanceMi ?? 0) > 0)
      .map((s) => {
        const miles = s._sum.distanceMi ?? 0;
        const fuelPurchased = purchasedByJurisdiction.get(s.jurisdiction) ?? 0;
        const taxableGallons = fleetMpg > 0 ? miles / fleetMpg : 0;
        return {
          jurisdiction: s.jurisdiction,
          milesDriven: miles,
          fuelPurchasedGal: fuelPurchased.toFixed(2),
          fleetMpg: fleetMpg.toFixed(3),
          taxableGallons: taxableGallons.toFixed(3),
          netTaxableGallons: (taxableGallons - fuelPurchased).toFixed(3),
        } satisfies IftaReportRow;
      })
      .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction));
  }

  async stream(params: IftaReportParamsDto): Promise<{ stream: NodeJS.ReadableStream; rowCount: number }> {
    const rows = await this.rows(params);
    async function* gen(): AsyncGenerator<IftaReportRow> {
      for (const row of rows) yield row;
    }
    return { stream: csvFromRows(gen()), rowCount: rows.length };
  }
}
