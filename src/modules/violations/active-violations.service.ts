import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { staleStatusCapAt } from '../drivers/lib/stale-status';
import { addDays, dayKey } from '../hos/engine/timezone';
import { HosRecalcRepository, type OpenDrivingRow } from '../hos-recalc/hos-recalc.repository';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import type { ViolationListQueryDto } from './dto/violations.dto';
import { ViolationsRepository } from './violations.repository';
import { ViolationsService } from './violations.service';

/** How far back an open DRIVING record is looked for (same bound as the open-driving sweep). */
export const ACTIVE_VIOLATIONS_LOOKBACK_DAYS = 14;
/** One engine check per open-driving driver per minute, whatever the number of panel reads. */
export const ACTIVE_VIOLATIONS_TTL_MS = 60_000;

/** "YYYY-MM-DD" → the UTC midnight Prisma uses for a `@db.Date` column. */
function utcDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

interface DriverCheck {
  at: number;
  /** The open DRIVING record the check was made for — a new record invalidates it at once. */
  since: number;
  /** BUG-002 — the stale cap of that record, or null while the status is plausible. */
  staleCapAt: Promise<Date | null>;
}

/**
 * BUG-003 (web panel only) — THE definition of an active HOS violation for every fleet screen:
 * W-01 dashboard (KPI + table), W-06 Drivers roster (`openViolations`, "N with active
 * violations") and W-08 HOS Logs (`Violations · today`).
 *
 *   An active violation is an OPEN `HosViolation` row — after the rows were brought in step with
 *   the live HOS engine (the same `computeCurrentState` the clocks next to them are read from),
 *   and excluding anything a STALE duty status (BUG-002, ELD connection lost) filed after its
 *   plausibility cap.
 *
 * Rows are written by `hos.recalc` when records arrive. A driver whose last record is DRIVING
 * keeps crossing limits with the clock alone, so between ingests (or with the worker down) the
 * clocks read "limit exceeded" while every list read 0. Before answering, this service checks
 * exactly those drivers and, when the engine holds a violation no row carries yet, runs the
 * existing idempotent `HosRecalcService.recalculate` (upsert on (driverId, logDate, type)) —
 * the same write the ingest path and the worker sweep make. A stale status is only written up to
 * its cap (UI-002a). Mobile paths and the shared engine are untouched.
 */
@Injectable()
export class ActiveViolationsService {
  private readonly logger = new Logger(ActiveViolationsService.name);
  private readonly checks = new Map<string, DriverCheck>();
  private fleetScan: { at: number; rows: Promise<OpenDrivingRow[]> } | null = null;

  constructor(
    private readonly repo: ViolationsRepository,
    private readonly hos: HosRecalcService,
    private readonly hosRepo: HosRecalcRepository,
    private readonly violations: ViolationsService,
  ) {}

  /** W-01 / B-6 `GET /violations` — the fleet list, active rows only when `status=OPEN`. */
  async list(query: ViolationListQueryDto, now: Date = new Date()) {
    const exclude = await this.refresh(now, query.driverId ? [query.driverId] : undefined);
    return this.violations.list(query, now, query.status === 'OPEN' ? exclude : []);
  }

  /** W-06 roster — active violations per driver (drivers without any are absent). */
  async openCountsByDriver(driverIds: string[], now: Date = new Date()): Promise<Map<string, number>> {
    if (driverIds.length === 0) return new Map();
    const exclude = await this.refresh(now, driverIds);
    return this.repo.countByDriver({ AND: [{ driverId: { in: driverIds }, status: 'OPEN' }, ...exclude] });
  }

  /**
   * W-08 — refreshes one driver and answers whether an OPEN row of theirs is active. The log-day
   * payload reads its rows itself (shared with mobile); this is the filter the web view applies.
   */
  async activeFilter(driverId: string, now: Date = new Date()): Promise<(row: { status: string; occurredAt: Date }) => boolean> {
    await this.refresh(now, [driverId]);
    const capAt = await this.checks.get(driverId)?.staleCapAt;
    return (row) => row.status !== 'OPEN' || !capAt || row.occurredAt.getTime() <= capAt.getTime();
  }

  /**
   * Brings the rows of open-driving drivers in step with the engine and returns the `NOT`
   * clauses that drop rows a stale status filed after its cap. Never throws: a failed check
   * leaves the stored rows as they are rather than failing the screen.
   */
  async refresh(now: Date, driverIds?: string[]): Promise<Prisma.HosViolationWhereInput[]> {
    let rows: OpenDrivingRow[];
    try {
      rows = await this.openDrivingDrivers(now);
    } catch (err) {
      this.logger.error({ err }, 'active violations: open-driving scan failed — stored rows used as they are');
      return [];
    }
    const wanted = driverIds ? new Set(driverIds) : null;
    const exclude: Prisma.HosViolationWhereInput[] = [];
    for (const row of rows) {
      if (wanted && !wanted.has(row.driverId)) continue;
      const capAt = await this.check(row, now).staleCapAt;
      if (capAt) exclude.push({ NOT: { driverId: row.driverId, occurredAt: { gt: capAt } } });
    }
    return exclude;
  }

  private openDrivingDrivers(now: Date): Promise<OpenDrivingRow[]> {
    if (this.fleetScan && now.getTime() - this.fleetScan.at < ACTIVE_VIOLATIONS_TTL_MS) return this.fleetScan.rows;
    const since = new Date(now.getTime() - ACTIVE_VIOLATIONS_LOOKBACK_DAYS * 86_400_000);
    const rows = this.hosRepo.findOpenDrivingDrivers(since, now);
    this.fleetScan = { at: now.getTime(), rows };
    rows.catch(() => {
      this.fleetScan = null;
    });
    return rows;
  }

  /** Cached per driver (and per open record) so concurrent screens share one engine run. */
  private check(row: OpenDrivingRow, now: Date): DriverCheck {
    const cached = this.checks.get(row.driverId);
    if (cached && cached.since === row.since.getTime() && now.getTime() - cached.at < ACTIVE_VIOLATIONS_TTL_MS) return cached;
    const check: DriverCheck = { at: now.getTime(), since: row.since.getTime(), staleCapAt: this.sync(row, now) };
    this.checks.set(row.driverId, check);
    return check;
  }

  private async sync(row: OpenDrivingRow, now: Date): Promise<Date | null> {
    let capAt: Date | null = null;
    try {
      let current = await this.hos.computeCurrentState(row.driverId, now);
      if (!current || current.state.currentStatus !== 'D') return null;
      // BUG-002 — an ELD that stopped reporting is not a driver still driving: nothing is filed
      // AFTER the cap. UI-002a — what the driver crossed BEFORE it (11 h, 14 h, 30-min break) is
      // still real, so the engine is read — and, when needed, the rows written — AT the cap.
      capAt = staleStatusCapAt(current.state.currentStatus, current.state.statusSince, now);
      const at = capAt ?? now;
      if (capAt) {
        current = await this.hos.computeCurrentState(row.driverId, capAt);
        if (!current) return capAt;
      }
      const { state, timezone } = current;

      const todayKey = dayKey(timezone, at);
      const earliest = addDays(dayKey(timezone, now), -ACTIVE_VIOLATIONS_LOOKBACK_DAYS);
      const start = dayKey(timezone, row.since);
      const fromKey = start < earliest ? earliest : start;
      const expected = state.violations.filter((violation) => violation.logDate >= fromKey);
      if (expected.length === 0) return capAt;

      const stored = await this.hosRepo.findViolations(row.driverId, utcDate(fromKey), utcDate(todayKey));
      // OPEN is filed, RESOLVED was closed by a human (never reopened) — AUTO_CLEARED is neither.
      const filed = new Set(stored.filter((s) => s.status !== 'AUTO_CLEARED').map((s) => `${dayKey('UTC', s.logDate)}|${s.type}`));
      if (expected.every((violation) => filed.has(`${violation.logDate}|${violation.type}`))) return capAt;

      await this.hos.recalculate({ driverId: row.driverId, fromDate: fromKey }, at);
      return capAt;
    } catch (err) {
      this.logger.error({ err, driverId: row.driverId }, 'active violations: engine check failed — stored rows used as they are');
      return capAt;
    }
  }
}
