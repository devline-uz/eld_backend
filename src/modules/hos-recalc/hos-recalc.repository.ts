import { Injectable } from '@nestjs/common';
import type { DailyLog, Driver, EldEvent, HosViolation, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

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
