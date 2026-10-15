import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DailyLog, Driver, EldEvent, HosViolation, UnidentifiedSegment } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

/** LIVE-001 — `HosViolation.resolutionNote` of a row the recalculation cleared (≤ 60 chars, as a human note). */
export const AUTO_CLEAR_NOTE = 'Auto-cleared: no longer supported by the driver\'s records';
/** LIVE-001 — `AuditLog.actorId` of the SYSTEM actor that clears violations. */
export const HOS_RECALC_ACTOR_ID = 'system:hos-recalc';

/** B-055 — one driver's event lower bound for a batched read. */
export interface HosEventWindow {
  driverId: string;
  from: Date;
}

/**
 * B-055 — the slim `EldEvent` projection the engine input is built from. CODE-006: active records
 * AND their "Inactive — Changed" markers (`recordStatus = 2`, `supersedesId`), so the service can
 * retire superseded records through `activeRecords` exactly as the RODS view does.
 */
export interface HosEventRow {
  driverId: string;
  id: bigint;
  recordStatus: number;
  supersedesId: bigint | null;
  eventType: number;
  eventCode: number;
  eventDateTime: Date;
  eventSequenceId: number;
  locationPrecisionMi: number;
}

/** B-059 — the `EldEvent` columns a RODS day header is rebuilt from (every record status). */
export type HosRodsEventRow = Pick<
  EldEvent,
  'id' | 'eventType' | 'eventCode' | 'eventDateTime' | 'recordStatus' | 'recordOrigin' | 'eventSequenceId' | 'supersedesId' | 'totalVehicleMiles' | 'vehicleId'
>;

/** Open-driving sweep — a driver whose latest duty-status record is DRIVING, and since when. */
export interface OpenDrivingRow {
  driverId: string;
  homeTerminalTimezone: string;
  since: Date;
}

/** B-055 — the slim `DailyLog` projection the recap consumes. */
export interface HosDailyLogRow {
  driverId: string;
  logDate: Date;
  onDutySec: number;
  drivingSec: number;
}

/**
 * TZ §3.5 / §8.4 — every database call of the HOS recalculation lives here. The engine in
 * `modules/hos/` stays pure; this repository is the only side of Phase 4 that knows Prisma.
 */
@Injectable()
export class HosRecalcRepository extends BaseRepository<
  HosViolation,
  Prisma.HosViolationWhereInput,
  Prisma.HosViolationWhereUniqueInput,
  Prisma.HosViolationCreateInput,
  Prisma.HosViolationUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    HosViolation,
    Prisma.HosViolationWhereInput,
    Prisma.HosViolationWhereUniqueInput,
    Prisma.HosViolationCreateInput,
    Prisma.HosViolationUpdateInput
  > {
    return this.prisma.hosViolation;
  }

  findDriver(driverId: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { id: driverId } });
  }

  /** FE-01 — the carrier (office) time zone HOS alert text is written in; null when unset. */
  async carrierTimezone(): Promise<string | null> {
    const carrier = await this.prisma.carrier.findFirst({ select: { timezone: true } });
    return carrier?.timezone ?? null;
  }

  /**
   * §5.5 — the engine input, ordered; the partition key (`eventDateTime`) drives the scan.
   * CODE-006 — active records PLUS the "Inactive — Changed" markers (`recordStatus = 2`): a record
   * retired by an accepted edit keeps `recordStatus = 1` on its own (append-only) row and is
   * identified only through the marker pointing at it (D-019). A marker is written at its
   * target's own instant, so this window always holds the marker of every record it holds. The
   * caller filters through `activeRecords` (`logs/rods.ts`), the same rule the RODS view uses.
   */
  findEvents(driverId: string, from: Date, to: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId, recordStatus: { in: [1, 2] }, eventDateTime: { gte: from, lte: to } },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  }

  /** §8.1 — the per-day on-duty history the recap needs, one row per RODS day. */
  findDailyLogs(driverId: string, from: Date, to: Date): Promise<DailyLog[]> {
    return this.prisma.dailyLog.findMany({
      where: { driverId, logDate: { gte: from, lte: to } },
      orderBy: { logDate: 'asc' },
    });
  }

  /**
   * B-055 — batched `findEvents` with a PER-DRIVER lower bound. One statement: an `unnest` of
   * (driverId, from) pairs LATERAL-joined onto the `(driverId, eventDateTime)` index, so each
   * driver scans only its own window instead of the page sharing one `min(from)` range.
   *
   * Only the columns the engine input needs, and only eventType 1 / 3 — the mapper ignores every
   * other type, so the engine input is unchanged. CODE-006: `recordStatus` 1 and 2 with `id` /
   * `supersedesId`, so superseded records are retired through `activeRecords` (as `findEvents`).
   * `(driverId, eventSequenceId, eventDateTime)` is unique, so the ordering is total and matches
   * `findEvents`.
   *
   * `perDriverLimit` is a hard LIMIT per driver; the caller asks for cap + 1 so it can tell a
   * full window from a truncated one and refuse to compute clocks from the latter.
   */
  findEventsForDrivers(windows: HosEventWindow[], to: Date, perDriverLimit: number): Promise<HosEventRow[]> {
    if (windows.length === 0) return Promise.resolve([]);
    const ids = windows.map((w) => w.driverId);
    const froms = windows.map((w) => w.from.toISOString());
    return this.prisma.$queryRaw<HosEventRow[]>(Prisma.sql`
      SELECT w."driverId", e."id", e."recordStatus", e."supersedesId", e."eventType", e."eventCode", e."eventDateTime", e."eventSequenceId", e."locationPrecisionMi"
      FROM unnest(${ids}::text[], ${froms}::text[]) WITH ORDINALITY AS w("driverId", "fromIso", ord)
      CROSS JOIN LATERAL (
        SELECT "id", "recordStatus", "supersedesId", "eventType", "eventCode", "eventDateTime", "eventSequenceId", "locationPrecisionMi"
        FROM "EldEvent"
        WHERE "driverId" = w."driverId" AND "recordStatus" IN (1, 2) AND "eventType" IN (1, 3)
          AND "eventDateTime" >= w."fromIso"::timestamp AND "eventDateTime" <= ${to}
        ORDER BY "eventDateTime" ASC, "eventSequenceId" ASC
        LIMIT ${perDriverLimit}::int
      ) e
      ORDER BY w.ord, e."eventDateTime" ASC, e."eventSequenceId" ASC`);
  }

  /**
   * Batched `findDailyLogs` for a roster page — only the recap columns. `@@unique([driverId,
   * logDate])` bounds this to one row per driver per day of the (≤ 10-day) range.
   */
  findDailyLogsForDrivers(driverIds: string[], from: Date, to: Date): Promise<HosDailyLogRow[]> {
    return this.prisma.dailyLog.findMany({
      where: { driverId: { in: driverIds }, logDate: { gte: from, lte: to } },
      orderBy: { logDate: 'asc' },
      select: { driverId: true, logDate: true, onDutySec: true, drivingSec: true },
    });
  }

  findViolations(driverId: string, from: Date, to: Date): Promise<HosViolation[]> {
    return this.prisma.hosViolation.findMany({ where: { driverId, logDate: { gte: from, lte: to } } });
  }

  /**
   * §8.4 rule 1 — idempotent write on `@@unique([driverId, logDate, type])`. The row `id`
   * survives every recalculation; only the measured values are refreshed.
   */
  async upsertViolation(args: {
    driverId: string;
    logDate: Date;
    type: HosViolation['type'];
    occurredAt: Date;
    exceededBySec: number;
    detail: string;
  }): Promise<HosViolation> {
    const { driverId, logDate, type, occurredAt, exceededBySec, detail } = args;
    // CODE-069 — link the row to its RODS day header (`rebuildHeaders` runs first in `recalculate`,
    // so the header exists); `dailyLogId` used to be null on every row.
    const header = await this.prisma.dailyLog.findUnique({
      where: { driverId_logDate: { driverId, logDate } },
      select: { id: true },
    });
    const dailyLogId = header?.id ?? null;
    return this.prisma.hosViolation.upsert({
      where: { driverId_logDate_type: { driverId, logDate, type } },
      create: { driverId, logDate, type, occurredAt, exceededBySec, detail, status: 'OPEN', dailyLogId },
      // LIVE-001 — an AUTO_CLEARED row the records support again is re-opened without its clearing
      // note (the clearing itself stays in `AuditLog`). Never called for a RESOLVED row (rule 3).
      update: {
        occurredAt,
        exceededBySec,
        detail,
        status: 'OPEN',
        resolvedAt: null,
        resolutionNote: null,
        recalcVersion: { increment: 1 },
        ...(dailyLogId && { dailyLogId }),
      },
    });
  }

  /**
   * §8.4 rule 2 — gone from the fresh result but still OPEN: cleared, never deleted.
   *
   * LIVE-001 — the clearing leaves an audit trail: the row records when and why it was cleared
   * (`resolvedAt` + `resolutionNote`, `resolvedById` stays null — no human closed it), and an
   * append-only `AuditLog` entry (`HOS_VIOLATION_AUTO_CLEARED`, SYSTEM actor) keeps the
   * before / after even if a later recalculation re-opens the row. Guarded on `status = OPEN`, so
   * a human resolve that won the race is never overwritten. Returns false when nothing changed.
   */
  autoClear(id: string, context: { engineVersion: string; now?: Date } = { engineVersion: 'unknown' }): Promise<boolean> {
    const now = context.now ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.hosViolation.findUnique({ where: { id } });
      if (!before || before.status !== 'OPEN') return false;
      const result = await tx.hosViolation.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: 'AUTO_CLEARED', resolvedAt: now, resolutionNote: AUTO_CLEAR_NOTE, recalcVersion: { increment: 1 } },
      });
      if (result.count !== 1) return false;
      await tx.auditLog.create({
        data: {
          actorId: HOS_RECALC_ACTOR_ID,
          actorType: 'SYSTEM',
          action: 'HOS_VIOLATION_AUTO_CLEARED',
          objectType: 'HosViolation',
          objectId: id,
          before: {
            status: 'OPEN',
            driverId: before.driverId,
            logDate: before.logDate.toISOString().slice(0, 10),
            type: before.type,
            occurredAt: before.occurredAt.toISOString(),
            exceededBySec: before.exceededBySec,
            detail: before.detail,
          },
          after: { status: 'AUTO_CLEARED', resolvedAt: now.toISOString(), hosEngineVersion: context.engineVersion },
          detail: 'HOS recalculation: the driver\'s current records no longer produce this violation (TZ §8.4 rule 2).',
        },
      });
      return true;
    });
  }

  /** §8.4 rule 3 — a human closed this one; only the magnitude may change. */
  refreshResolved(id: string, exceededBySec: number): Promise<HosViolation> {
    return this.prisma.hosViolation.update({
      where: { id },
      data: { exceededBySec, recalcVersion: { increment: 1 } },
    });
  }

  /**
   * B-059 — every record in the window, ACTIVE OR NOT: `buildRodsDay` needs the
   * "Inactive — Changed" markers to retire superseded records (D-019).
   */
  findRodsEvents(driverId: string, from: Date, to: Date): Promise<HosRodsEventRow[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId, eventDateTime: { gte: from, lte: to } },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
      select: {
        id: true,
        eventType: true,
        eventCode: true,
        eventDateTime: true,
        recordStatus: true,
        recordOrigin: true,
        eventSequenceId: true,
        supersedesId: true,
        totalVehicleMiles: true,
        vehicleId: true,
      },
    });
  }

  /** B-059 — segments on the driver's units touching the window, for `hasUnassigned`. */
  findUnidentifiedSegments(vehicleIds: string[], from: Date, to: Date): Promise<Array<Pick<UnidentifiedSegment, 'status' | 'startAt' | 'endAt'>>> {
    if (!vehicleIds.length) return Promise.resolve([]);
    return this.prisma.unidentifiedSegment.findMany({
      // B-83 — a segment awaiting driver confirmation is still unattributed (same set as `daily-log-header`).
      where: { vehicleId: { in: vehicleIds }, status: { in: ['PENDING', 'PENDING_CONFIRMATION'] }, startAt: { lte: to }, endAt: { gte: from } },
      select: { status: true, startAt: true, endAt: true },
    });
  }

  /** B-059 / §5.8 — the RODS day totals. Certification state is NEVER touched here (§9.2). */
  upsertDailyLogTotals(args: {
    driverId: string;
    logDate: Date;
    timezone: string;
    offDutySec: number;
    sleeperSec: number;
    drivingSec: number;
    onDutySec: number;
    totalDistanceMi: number;
    hasUnassigned: boolean;
    hasEdits: boolean;
  }): Promise<DailyLog> {
    const { driverId, logDate, ...rest } = args;
    return this.prisma.dailyLog.upsert({
      where: { driverId_logDate: { driverId, logDate } },
      create: { driverId, logDate, ...rest },
      update: { ...rest, recalculatedAt: new Date(), recalcVersion: { increment: 1 } },
    });
  }

  /** Keeps the RODS day header in step with the recalculated violations (§5.7). */
  updateDailyLogViolationFlags(driverId: string, logDate: Date, violationCount: number): Promise<number> {
    return this.prisma.dailyLog
      .updateMany({
        where: { driverId, logDate },
        data: {
          hasViolation: violationCount > 0,
          violationCount,
          recalculatedAt: new Date(),
          recalcVersion: { increment: 1 },
        },
      })
      .then((result) => result.count);
  }

  /**
   * Open-driving sweep — ACTIVE drivers whose latest active duty-status record (inside
   * `[since, now]`) is DRIVING. Their 11 h / 14 h / 30 min / cycle overruns keep growing with
   * the clock alone, without a new record arriving to trigger `hos.recalc`, so they are the only
   * drivers whose stored violations can go stale between ingests.
   */
  findOpenDrivingDrivers(since: Date, now: Date): Promise<OpenDrivingRow[]> {
    return this.prisma.$queryRaw<OpenDrivingRow[]>(Prisma.sql`
      SELECT last."driverId", last."homeTerminalTimezone", last."eventDateTime" AS "since"
      FROM (
        SELECT DISTINCT ON (e."driverId") e."driverId", d."homeTerminalTimezone", e."eventCode", e."eventDateTime"
        FROM "EldEvent" e
        JOIN "Driver" d ON d."id" = e."driverId"
        WHERE e."eventType" = 1 AND e."recordStatus" = 1
          AND e."eventDateTime" >= ${since} AND e."eventDateTime" <= ${now}
          AND d."deletedAt" IS NULL AND d."status" = 'ACTIVE'
        ORDER BY e."driverId", e."eventDateTime" DESC, e."eventSequenceId" DESC
      ) last
      WHERE last."eventCode" = 3`);
  }
}
