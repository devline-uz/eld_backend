import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../../../core/prisma/prisma.service';
import type { ActivitySummaryQueryDto, ActivitySummarySortField } from '../dto/reports.dto';

/**
 * `GET /reports/activity/summary` (gap B-46, `web/backend-gaps.md`) — the JSON aggregate the
 * web needs for W-13 Activity, W-15 FMCSA pack and the dashboard so it stops issuing one
 * `GET /logs/:driverId/range` call per driver (308 calls / 3s→15s latency observed in QA).
 *
 * Computed straight from the persisted `DailyLog` header (per-RODS-day totals, rebuilt nightly
 * by `hos-recalc` / `hos.recalc` through the real builder — see `daily-log-header.ts`) and
 * `HosViolation.exceededBySec`-bearing rows, aggregated in SQL with GROUP BY. Never loads
 * `EldEvent` rows into memory (that is exactly the B-055 OOM pattern this must not repeat) and
 * never re-derives `LogsService.getRange` per driver (that is the N+1 this endpoint replaces —
 * see `activity-report.generator.ts` for the CSV export that still does that per-driver walk
 * for a single-driver/short-range CSV, which is a different, already-bounded use case).
 *
 * `DailyLog.logDate` is a plain `@db.Date` already computed by `buildDailyLogHeaders` in the
 * driver's home-terminal timezone (never `Carrier.timezone`) — so RODS day boundaries are
 * correct here without re-deriving them; only the from/to -> previous-period math below needs
 * a timezone-free day count.
 */
export interface ActivitySummaryRow {
  driverId: string;
  name: string;
  days: number;
  offSec: number;
  sbSec: number;
  drivingSec: number;
  onSec: number;
  distanceMi: number;
  violations: number;
  certifiedDays: number;
}

export interface ActivitySummaryKpis {
  drivingSec: number;
  /** `null` when the previous period (same length, immediately before `from`) has no
   * `DailyLog` data at all for the filtered driver set, or when its `drivingSec` is 0 (a
   * percentage against zero is undefined, never fabricated as 0 or infinity). */
  drivingDeltaPct: number | null;
  onDutySec: number;
  distanceMi: number;
  violations: number;
  /** Absolute count delta (current − previous). `null` only when the previous period has no
   * `DailyLog` data at all — a real previous count of 0 still yields a real delta. */
  violationsDelta: number | null;
}

export interface ActivitySummaryResult {
  kpis: ActivitySummaryKpis;
  items: ActivitySummaryRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface Filters {
  driverId?: string;
  terminal?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'TERMINATED';
}

/** Whitelisted sort columns — `sort` is NEVER interpolated into SQL directly. */
const SORT_COLUMNS: Record<ActivitySummarySortField, string> = {
  name: '(d."lastName" || \', \' || d."firstName")',
  days: 'days',
  offSec: 'off_sec',
  sbSec: 'sb_sec',
  drivingSec: 'driving_sec',
  onSec: 'on_sec',
  distanceMi: 'distance_mi',
  violations: 'violations',
  certifiedDays: 'certified_days',
};

function buildFilterSql(filters: Filters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (filters.driverId) clauses.push(Prisma.sql`d."id" = ${filters.driverId}`);
  if (filters.terminal) clauses.push(Prisma.sql`d."homeTerminalName" = ${filters.terminal}`);
  if (filters.status) clauses.push(Prisma.sql`d."status" = ${filters.status}::"DriverStatus"`);
  if (clauses.length === 0) return Prisma.sql``;
  return Prisma.sql`AND ${Prisma.join(clauses, ' AND ')}`;
}

interface TotalsRow {
  driving_sec: bigint | number | null;
  on_sec: bigint | number | null;
  distance_mi: bigint | number | null;
  violations: bigint | number | null;
  has_data: boolean;
}

@Injectable()
export class ActivitySummaryGenerator {
  constructor(private readonly prisma: PrismaService) {}

  async summary(params: ActivitySummaryQueryDto): Promise<ActivitySummaryResult> {
    const filters: Filters = { driverId: params.driverId, terminal: params.terminal, status: params.status };
    const [field, dir] = params.sort.split(':') as [ActivitySummarySortField, 'asc' | 'desc'];
    const orderCol = SORT_COLUMNS[field];
    const orderDir = dir === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;

    const { from, to } = params;
    const prevRange = previousPeriod(from, to);

    const [page, current, previous] = await Promise.all([
      this.fetchPage(from, to, filters, orderCol, orderDir, params.page, params.limit),
      this.fetchTotals(from, to, filters),
      this.fetchTotals(prevRange.from, prevRange.to, filters),
    ]);

    const drivingDeltaPct =
      previous.hasData && previous.drivingSec > 0
        ? ((current.drivingSec - previous.drivingSec) / previous.drivingSec) * 100
        : null;
    const violationsDelta = previous.hasData ? current.violations - previous.violations : null;

    return {
      kpis: {
        drivingSec: current.drivingSec,
        drivingDeltaPct: drivingDeltaPct === null ? null : Number(drivingDeltaPct.toFixed(1)),
        onDutySec: current.onDutySec,
        distanceMi: current.distanceMi,
        violations: current.violations,
        violationsDelta,
      },
      items: page.items,
      page: params.page,
      limit: params.limit,
      total: page.total,
      totalPages: Math.max(1, Math.ceil(page.total / params.limit)),
    };
  }

  private async fetchPage(
    from: string,
    to: string,
    filters: Filters,
    orderCol: string,
    orderDir: Prisma.Sql,
    page: number,
    limit: number,
  ): Promise<{ items: ActivitySummaryRow[]; total: number }> {
    const offset = (page - 1) * limit;
    const filterSql = buildFilterSql(filters);
    const rows = await this.prisma.$queryRaw<
      Array<{
        driverId: string;
        name: string;
        days: bigint;
        off_sec: bigint;
        sb_sec: bigint;
        driving_sec: bigint;
        on_sec: bigint;
        distance_mi: bigint;
        violations: bigint;
        certified_days: bigint;
        total: bigint;
      }>
    >(Prisma.sql`
      WITH agg AS (
        SELECT
          dl."driverId",
          COUNT(*)::int AS days,
          COALESCE(SUM(dl."offDutySec"), 0)::bigint AS off_sec,
          COALESCE(SUM(dl."sleeperSec"), 0)::bigint AS sb_sec,
          COALESCE(SUM(dl."drivingSec"), 0)::bigint AS driving_sec,
          COALESCE(SUM(dl."onDutySec"), 0)::bigint AS on_sec,
          COALESCE(SUM(dl."totalDistanceMi"), 0)::bigint AS distance_mi,
          COALESCE(SUM(dl."violationCount"), 0)::bigint AS violations,
          COALESCE(SUM(CASE WHEN dl."certified" THEN 1 ELSE 0 END), 0)::bigint AS certified_days
        FROM "DailyLog" dl
        WHERE dl."logDate" >= ${from}::date AND dl."logDate" <= ${to}::date
        GROUP BY dl."driverId"
      )
      SELECT
        d."id" AS "driverId",
        (d."lastName" || ', ' || d."firstName") AS name,
        agg.days,
        agg.off_sec,
        agg.sb_sec,
        agg.driving_sec,
        agg.on_sec,
        agg.distance_mi,
        agg.violations,
        agg.certified_days,
        COUNT(*) OVER ()::bigint AS total
      FROM agg
      JOIN "Driver" d ON d."id" = agg."driverId"
      WHERE 1 = 1 ${filterSql}
      ORDER BY ${Prisma.raw(orderCol)} ${orderDir}, d."id" ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const items: ActivitySummaryRow[] = rows.map((r) => ({
      driverId: r.driverId,
      name: r.name,
      days: Number(r.days),
      offSec: Number(r.off_sec),
      sbSec: Number(r.sb_sec),
      drivingSec: Number(r.driving_sec),
      onSec: Number(r.on_sec),
      distanceMi: Number(r.distance_mi),
      violations: Number(r.violations),
      certifiedDays: Number(r.certified_days),
    }));
    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return { items, total };
  }

  /** Fleet-wide totals for the KPI row, scoped by the same filters as the page but never
   * paginated — the KPI cards summarize the whole filtered driver set, not just one page. */
  private async fetchTotals(
    from: string,
    to: string,
    filters: Filters,
  ): Promise<{ drivingSec: number; onDutySec: number; distanceMi: number; violations: number; hasData: boolean }> {
    const filterSql = buildFilterSql(filters);
    const rows = await this.prisma.$queryRaw<TotalsRow[]>(Prisma.sql`
      SELECT
        COALESCE(SUM(dl."drivingSec"), 0)::bigint AS driving_sec,
        COALESCE(SUM(dl."onDutySec"), 0)::bigint AS on_sec,
        COALESCE(SUM(dl."totalDistanceMi"), 0)::bigint AS distance_mi,
        COALESCE(SUM(dl."violationCount"), 0)::bigint AS violations,
        (COUNT(*) > 0) AS has_data
      FROM "DailyLog" dl
      JOIN "Driver" d ON d."id" = dl."driverId"
      WHERE dl."logDate" >= ${from}::date AND dl."logDate" <= ${to}::date ${filterSql}
    `);
    const row = rows[0];
    return {
      drivingSec: Number(row?.driving_sec ?? 0),
      onDutySec: Number(row?.on_sec ?? 0),
      distanceMi: Number(row?.distance_mi ?? 0),
      violations: Number(row?.violations ?? 0),
      hasData: Boolean(row?.has_data),
    };
  }
}

/** Previous period of the same length immediately before `from` (inclusive on both ends,
 * date-only — the `DailyLog` day boundary is already fixed at build time in the driver's home
 * terminal timezone, so no further timezone handling belongs here). */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const start = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  const days = Math.round(end.diff(start, 'days').days) + 1;
  const prevTo = start.minus({ days: 1 });
  const prevFrom = prevTo.minus({ days: days - 1 });
  return { from: prevFrom.toISODate() as string, to: prevTo.toISODate() as string };
}
