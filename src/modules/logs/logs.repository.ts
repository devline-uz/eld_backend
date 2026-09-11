import { Injectable } from '@nestjs/common';
import type { DailyLog, Driver, EldEvent, HosViolation, Prisma, UnidentifiedSegment } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

/** Opaque transaction handle. */
export type LogsTx = Prisma.TransactionClient;

/**
 * TZ §3.5 — every database call of the RODS module lives here.
 *
 * `EldEvent` is append-only (§5.5): this repository exposes INSERT and SELECT only. The
 * §395.30 record-status transitions are expressed as appended records (see `edit-plan.ts`),
 * never as an UPDATE — the application role does not have the privilege and must not have it.
 */
@Injectable()
export class LogsRepository extends BaseRepository<
  DailyLog,
  Prisma.DailyLogWhereInput,
  Prisma.DailyLogWhereUniqueInput,
  Prisma.DailyLogCreateInput,
  Prisma.DailyLogUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    DailyLog,
    Prisma.DailyLogWhereInput,
    Prisma.DailyLogWhereUniqueInput,
    Prisma.DailyLogCreateInput,
    Prisma.DailyLogUpdateInput
  > {
    return this.prisma.dailyLog;
  }

  runInTransaction<T>(fn: (tx: LogsTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: 30_000, maxWait: 10_000 });
  }

  findDriver(driverId: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { id: driverId } });
  }

  /** Every record in the window, ACTIVE OR NOT — the RODS view must show the audit trail. */
  findEvents(driverId: string, from: Date, to: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId, eventDateTime: { gte: from, lte: to } },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  }

  findEventById(id: bigint): Promise<EldEvent | null> {
    return this.prisma.eldEvent.findFirst({ where: { id } });
  }

  /** Records that point at `ids` — the "Inactive — Changed" / accept / reject markers. */
  findSupersedingEvents(ids: bigint[]): Promise<EldEvent[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.eldEvent.findMany({ where: { supersedesId: { in: ids } } });
  }

  /** §9.1 — open carrier proposals for a driver (`recordStatus = 3`). */
  findEditRequests(driverId: string, from?: Date, to?: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: {
        driverId,
        recordStatus: 3,
        ...(from && to ? { eventDateTime: { gte: from, lte: to } } : {}),
      },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  }

  findViolations(driverId: string, from: Date, to: Date): Promise<HosViolation[]> {
    return this.prisma.hosViolation.findMany({
      where: { driverId, logDate: { gte: from, lte: to } },
      orderBy: { logDate: 'asc' },
    });
  }

  /** §5.9 — segments that touch the window, for the `hasUnassigned` flag on the day header. */
  findUnidentifiedSegments(vehicleIds: string[], from: Date, to: Date): Promise<UnidentifiedSegment[]> {
    if (!vehicleIds.length) return Promise.resolve([]);
    return this.prisma.unidentifiedSegment.findMany({
      where: { vehicleId: { in: vehicleIds }, startAt: { lte: to }, endAt: { gte: from } },
    });
  }

  findDailyLog(driverId: string, logDate: Date): Promise<DailyLog | null> {
    return this.prisma.dailyLog.findUnique({ where: { driverId_logDate: { driverId, logDate } } });
  }

  findDailyLogs(driverId: string, from: Date, to: Date): Promise<DailyLog[]> {
    return this.prisma.dailyLog.findMany({
      where: { driverId, logDate: { gte: from, lte: to } },
      orderBy: { logDate: 'asc' },
    });
  }

  /** §5.8 — the RODS day header. Certification state is NEVER touched here. */
  upsertDailyLog(args: {
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

  /** §9.2 — any change to a certified log drops the certification (re-certification required). */
  invalidateCertification(driverId: string, logDate: Date, timezone: string): Promise<DailyLog> {
    return this.prisma.dailyLog.upsert({
      where: { driverId_logDate: { driverId, logDate } },
      create: { driverId, logDate, timezone, certified: false, hasEdits: true },
      update: {
        certified: false,
        certifiedAt: null,
        certifiedById: null,
        certifierType: null,
        hasEdits: true,
      },
    });
  }

  certify(args: {
    driverId: string;
    logDate: Date;
    timezone: string;
    certifiedById: string;
    certifierType: 'DRIVER' | 'USER';
    signatureUrl?: string | null;
  }): Promise<DailyLog> {
    const { driverId, logDate, timezone, certifiedById, certifierType, signatureUrl } = args;
    const now = new Date();
    return this.prisma.dailyLog.upsert({
      where: { driverId_logDate: { driverId, logDate } },
      create: {
        driverId,
        logDate,
        timezone,
        certified: true,
        certifiedAt: now,
        certifiedById,
        certifierType,
        certificationCount: 1,
        ...(signatureUrl ? { signatureUrl } : {}),
      },
      update: {
        certified: true,
        certifiedAt: now,
        certifiedById,
        certifierType,
        certificationCount: { increment: 1 },
        ...(signatureUrl ? { signatureUrl } : {}),
      },
    });
  }

  /** §9.2 — days in the window without an active certification, oldest first. */
  async findUncertifiedDates(driverId: string, from: Date, to: Date): Promise<Date[]> {
    const rows = await this.prisma.dailyLog.findMany({
      where: { driverId, logDate: { gte: from, lte: to }, certified: false },
      orderBy: { logDate: 'asc' },
      select: { logDate: true },
    });
    return rows.map((row) => row.logDate);
  }

  /** The units the driver has records on — needed to attribute unidentified segments. */
  async findVehicleIdsForDriver(driverId: string, from: Date, to: Date): Promise<string[]> {
    const rows = await this.prisma.eldEvent.findMany({
      where: { driverId, eventDateTime: { gte: from, lte: to }, vehicleId: { not: null } },
      distinct: ['vehicleId'],
      select: { vehicleId: true },
    });
    return rows.map((row) => row.vehicleId).filter((id): id is string => Boolean(id));
  }
}
