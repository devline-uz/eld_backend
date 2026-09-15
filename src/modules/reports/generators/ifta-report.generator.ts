import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { PrismaService } from '../../../core/prisma/prisma.service';
import type { IftaReportParamsDto, IftaSummaryParamsDto } from '../dto/reports.dto';
import { csvFromRows } from '../lib/csv-stream';

export interface IftaReportRow {
  jurisdiction: string;
  milesDriven: number;
  fuelPurchasedGal: string;
  fleetMpg: string;
  taxableGallons: string;
  netTaxableGallons: string;
}

/** JSON summary for W-12 (gap B-46). Mirrors the CSV export exactly — same `IftaSegment` /
 * `FuelPurchase` aggregates, never re-derived or estimated differently. Shape matches
 * `web/src/shared/api/reports.ts` (`IftaSummary`/`IftaKpis`/`IftaJurisdictionTotals`) exactly,
 * including which fields are nullable — see D-054 in decisions.md. */
export interface IftaJurisdictionTotals {
  totalMiles: number;
  taxableMiles: number;
  /** `null` when the quarter has no `FuelPurchase` rows for this carrier at all (never faked
   * as 0 — a jurisdiction that legitimately had zero gallons purchased while others had some
   * still reports a real `0`, only the whole-quarter "no fuel data" case is `null`). */
  fuelGal: number | null;
  /** Fleet-wide MPG (IFTA does not track per-jurisdiction fuel economy). `null` under the same
   * condition as `fuelGal`. */
  mpg: number | null;
  /** No `TaxRate` model exists yet (per-jurisdiction IFTA tax rates are not persisted anywhere
   * in this schema) — always `null` until that data exists. See D-054 in decisions.md. */
  taxDueUsd: number | null;
}

export interface IftaSummaryRow extends IftaJurisdictionTotals {
  jurisdiction: string;
}

export interface IftaSummary {
  quarter: string;
  unitCount: number;
  kpis: {
    totalMiles: number;
    taxableMiles: number;
    /** `null` when `totalMiles` is 0 — nothing to compute a percentage of. */
    taxablePct: number | null;
    fuelGal: number | null;
    receiptCount: number | null;
    fleetMpg: number | null;
    fleetMpgPrev: number | null;
  };
  rows: IftaSummaryRow[];
  /** One "Total" row, same shape as a jurisdiction row minus `jurisdiction` (web WD-068). */
  totals: IftaJurisdictionTotals;
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

/** `2026-Q1` -> `2025-Q4`, etc. — the quarter immediately before `quarter`, for the W-12
 * `fleetMpgPrev` "vs prev." chip (TZ web/tz.md §20). */
export function previousQuarter(quarter: string): string {
  const [yearStr, qStr] = quarter.split('-Q');
  const year = Number(yearStr);
  const q = Number(qStr);
  return q === 1 ? `${year - 1}-Q4` : `${year}-Q${q - 1}`;
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

  /**
   * JSON summary for the W-12 IFTA screen (gap B-46) — `POST /reports/generate` still queues
   * the CSV asynchronously per §15; this is a synchronous read of the SAME persisted
   * `IftaSegment`/`FuelPurchase` totals (no separate/estimated computation, see D-042).
   * `fleetMpg`/row `mpg`/`taxDueUsd` are `null` rather than `0` whenever the underlying data
   * to derive them does not exist yet (no fuel purchases this quarter; no `TaxRate` model at
   * all) — a report screen must never show an invented number.
   */
  async summary(params: IftaSummaryParamsDto): Promise<IftaSummary> {
    const { quarter, vehicleId } = params;
    const { start, end } = quarterRange(quarter);
    const prevRange = quarterRange(previousQuarter(quarter));
    const vehicleFilter = vehicleId ? { vehicleId } : {};

    const [current, previous, unitRows] = await Promise.all([
      this.quarterTotals(start, end, vehicleFilter),
      this.quarterTotals(prevRange.start, prevRange.end, vehicleFilter),
      this.prisma.iftaSegment.findMany({
        where: { ...vehicleFilter, date: { gte: start, lte: end } },
        distinct: ['vehicleId'],
        select: { vehicleId: true },
      }),
    ]);

    const rows: IftaSummaryRow[] = current.segments
      .filter((s) => (s._sum.distanceMi ?? 0) > 0)
      .map((s) => {
        const miles = s._sum.distanceMi ?? 0;
        const fuelGal = current.purchasedByJurisdiction.get(s.jurisdiction) ?? 0;
        return {
          jurisdiction: s.jurisdiction,
          totalMiles: miles,
          taxableMiles: miles, // no exemption/trip-permit model exists — every mile is taxable (D-054)
          fuelGal: current.hasFuelData ? Number(fuelGal.toFixed(2)) : null,
          mpg: current.fleetMpg === null ? null : Number(current.fleetMpg.toFixed(2)),
          taxDueUsd: null, // no TaxRate model — see D-054
        } satisfies IftaSummaryRow;
      })
      .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction));

    return {
      quarter,
      unitCount: unitRows.length,
      kpis: {
        totalMiles: current.totalMiles,
        taxableMiles: current.totalMiles,
        taxablePct: current.totalMiles > 0 ? 100 : null,
        fuelGal: current.hasFuelData ? Number(current.totalGallonsBurned.toFixed(2)) : null,
        receiptCount: current.hasFuelData ? current.receiptCount : null,
        fleetMpg: current.fleetMpg === null ? null : Number(current.fleetMpg.toFixed(2)),
        fleetMpgPrev: previous.fleetMpg === null ? null : Number(previous.fleetMpg.toFixed(2)),
      },
      rows,
      totals: {
        totalMiles: current.totalMiles,
        taxableMiles: current.totalMiles,
        fuelGal: current.hasFuelData ? Number(current.totalGallonsBurned.toFixed(2)) : null,
        mpg: current.fleetMpg === null ? null : Number(current.fleetMpg.toFixed(2)),
        taxDueUsd: null,
      },
    };
  }

  /** Shared aggregate used by `summary()` for both the requested quarter and the previous one. */
  private async quarterTotals(
    start: Date,
    end: Date,
    vehicleFilter: { vehicleId?: string },
  ): Promise<{
    segments: { jurisdiction: string; _sum: { distanceMi: number | null } }[];
    purchasedByJurisdiction: Map<string, number>;
    totalMiles: number;
    totalGallonsBurned: number;
    receiptCount: number;
    hasFuelData: boolean;
    fleetMpg: number | null;
  }> {
    const [segments, purchases, receiptCount] = await Promise.all([
      this.prisma.iftaSegment.groupBy({
        by: ['jurisdiction'],
        where: { ...vehicleFilter, date: { gte: start, lte: end } },
        _sum: { distanceMi: true },
      }),
      this.prisma.fuelPurchase.groupBy({
        by: ['jurisdiction'],
        where: { ...vehicleFilter, purchasedAt: { gte: start, lte: end } },
        _sum: { gallons: true },
      }),
      this.prisma.fuelPurchase.count({ where: { ...vehicleFilter, purchasedAt: { gte: start, lte: end } } }),
    ]);
    const purchasedByJurisdiction = new Map(
      purchases.map((p) => [p.jurisdiction, Number(p._sum.gallons ?? 0)]),
    );
    const totalMiles = segments.reduce((sum, s) => sum + (s._sum.distanceMi ?? 0), 0);
    const totalGallonsBurned = purchases.reduce((sum, p) => sum + Number(p._sum.gallons ?? 0), 0);
    const hasFuelData = receiptCount > 0;
    const fleetMpg = hasFuelData && totalGallonsBurned > 0 ? totalMiles / totalGallonsBurned : null;
    return { segments, purchasedByJurisdiction, totalMiles, totalGallonsBurned, receiptCount, hasFuelData, fleetMpg };
  }
}
