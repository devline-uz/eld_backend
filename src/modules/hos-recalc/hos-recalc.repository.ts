import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DailyLog, Driver, EldEvent, HosViolation, UnidentifiedSegment } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

/** B-055 — one driver's event lower bound for a batched read. */
export interface HosEventWindow {
  driverId: string;
  from: Date;
}

/** B-055 — the slim `EldEvent` projection the engine mapper consumes (active records only). */
export interface HosEventRow {
  driverId: string;
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

  /** §5.5 — active records only, ordered; the partition key (`eventDateTime`) drives the scan. */
  findEvents(driverId: string, from: Date, to: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId, recordStatus: 1, eventDateTime: { gte: from, lte: to } },
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
   * Only the columns `mapEldEventsToNormalized` reads, and only eventType 1 / 3 — the mapper
   * ignores every other type, so the engine input is unchanged. `(driverId, eventSequenceId,
   * eventDateTime)` is unique, so the ordering is total and matches `findEvents`.
   *
   * `perDriverLimit` is a hard LIMIT per driver; the caller asks for cap + 1 so it can tell a
   * full window from a truncated one and refuse to compute clocks from the latter.
   */
  findEventsForDrivers(windows: HosEventWindow[], to: Date, perDriverLimit: number): Promise<HosEventRow[]> {
    if (windows.length === 0) return Promise.resolve([]);
    const ids = windows.map((w) => w.driverId);
    const froms = windows.map((w) => w.from.toISOString());
    return this.prisma.$queryRaw<HosEventRow[]>(Prisma.sql`
      SELECT w."driverId", e."eventType", e."eventCode", e."eventDateTime", e."eventSequenceId", e."locationPrecisionMi"
      FROM unnest(${ids}::text[], ${froms}::text[]) WITH ORDINALITY AS w("driverId", "fromIso", ord)
      CROSS JOIN LATERAL (
        SELECT "eventType", "eventCode", "eventDateTime", "eventSequenceId", "locationPrecisionMi"
        FROM "EldEvent"
        WHERE "driverId" = w."driverId" AND "recordStatus" = 1 AND "eventType" IN (1, 3)
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
  upsertViolation(args: {
    driverId: string;
    logDate: Date;
    type: HosViolation['type'];
    occurredAt: Date;
    exceededBySec: number;
    detail: string;
  }): Promise<HosViolation> {
    const { driverId, logDate, type, occurredAt, exceededBySec, detail } = args;
    return this.prisma.hosViolation.upsert({
      where: { driverId_logDate_type: { driverId, logDate, type } },
      create: { driverId, logDate, type, occurredAt, exceededBySec, detail, status: 'OPEN' },
      update: { occurredAt, exceededBySec, detail, status: 'OPEN', recalcVersion: { increment: 1 } },
    });
  }

  /** §8.4 rule 2 — gone from the fresh result but still OPEN: cleared, never deleted. */
  autoClear(id: string): Promise<HosViolation> {
    return this.prisma.hosViolation.update({
      where: { id },
      data: { status: 'AUTO_CLEARED', recalcVersion: { increment: 1 } },
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
      where: { vehicleId: { in: vehicleIds }, status: 'PENDING', startAt: { lte: to }, endAt: { gte: from } },
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
}
