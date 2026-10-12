import { Injectable } from '@nestjs/common';
import type { DriverScore, Prisma, SafetyEvent } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface SafetyEventFilter {
  driverId?: string;
  vehicleId?: string;
  type?: SafetyEvent['type'];
  status?: SafetyEvent['status'];
  from?: Date;
  to?: Date;
}

@Injectable()
export class SafetyRepository extends BaseRepository<
  SafetyEvent,
  Prisma.SafetyEventWhereInput,
  Prisma.SafetyEventWhereUniqueInput,
  Prisma.SafetyEventCreateInput,
  Prisma.SafetyEventUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    SafetyEvent,
    Prisma.SafetyEventWhereInput,
    Prisma.SafetyEventWhereUniqueInput,
    Prisma.SafetyEventCreateInput,
    Prisma.SafetyEventUpdateInput
  > {
    return this.prisma.safetyEvent;
  }

  async list(filter: SafetyEventFilter, page: number, limit: number) {
    const where: Prisma.SafetyEventWhereInput = {
      ...(filter.driverId && { driverId: filter.driverId }),
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.type && { type: filter.type }),
      ...(filter.status && { status: filter.status }),
      ...((filter.from || filter.to) && {
        occurredAt: { ...(filter.from && { gte: filter.from }), ...(filter.to && { lte: filter.to }) },
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.safetyEvent.findMany({ where, orderBy: { occurredAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.safetyEvent.count({ where }),
    ]);
    return { items, total };
  }

  createMany(rows: Prisma.SafetyEventCreateManyInput[]): Promise<Prisma.BatchPayload> {
    return this.prisma.safetyEvent.createMany({ data: rows });
  }

  /** §20 B-43 — driver-level coaching assignment: the most recent not-yet-coached event for
   * this driver, so "Assign coaching" from the scorecard row does not first require picking a
   * specific event in the events list. */
  findLatestOpenForDriver(driverId: string): Promise<SafetyEvent | null> {
    return this.prisma.safetyEvent.findFirst({
      where: { driverId, status: { in: ['NEW', 'REVIEWED'] } },
      orderBy: { occurredAt: 'desc' },
    });
  }

  /**
   * D-141 — SafetyEvent counts feeding `computeDriverScore`, per driver / type / severity, for
   * events in [from, to). DISMISSED events (a reviewer ruled them false positives) never count;
   * NEW, REVIEWED and COACHED do — coaching does not erase that the event happened.
   */
  eventCountsForDrivers(driverIds: string[], from: Date, to: Date) {
    return this.prisma.safetyEvent.groupBy({
      by: ['driverId', 'type', 'severity'],
      where: { driverId: { in: driverIds }, occurredAt: { gte: from, lt: to }, status: { not: 'DISMISSED' } },
      _count: { _all: true },
    });
  }

  /** D-141 — read-only: drivers the nightly scorecard considers (not soft-deleted). */
  scoringDrivers() {
    return this.prisma.driver.findMany({
      where: { deletedAt: null },
      select: { id: true, firstName: true, lastName: true, status: true, homeTerminalTimezone: true },
    });
  }

  /** D-141 — read-only: Σ `DailyLog.totalDistanceMi` per driver over home-terminal days
   * [from, to] (`logDate` is already the driver's local RODS day). */
  async milesByDriver(fromDay: Date, toDay: Date): Promise<Map<string, number>> {
    const groups = await this.prisma.dailyLog.groupBy({
      by: ['driverId'],
      where: { logDate: { gte: fromDay, lte: toDay } },
      _sum: { totalDistanceMi: true },
    });
    return new Map(groups.map((g) => [g.driverId, g._sum.totalDistanceMi ?? 0]));
  }

  /** D-141 — read-only: HOS violations per driver whose RODS day is in [from, to]. OPEN and
   * RESOLVED count (resolving a violation does not undo it); AUTO_CLEARED do not (a recalc found
   * it was never a violation). */
  async hosViolationsByDriver(fromDay: Date, toDay: Date): Promise<Map<string, number>> {
    const groups = await this.prisma.hosViolation.groupBy({
      by: ['driverId'],
      where: { logDate: { gte: fromDay, lte: toDay }, status: { not: 'AUTO_CLEARED' } },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.driverId, g._count._all]));
  }

  /**
   * D-141 — writes one period's rows atomically: upserts every computed driver and removes rows
   * of that period for drivers no longer scored (e.g. soft-deleted since the last run), so a
   * re-run is idempotent.
   */
  async replacePeriodScores(
    periodStart: Date,
    periodEnd: Date,
    rows: Array<Omit<Prisma.DriverScoreCreateManyInput, 'periodStart' | 'periodEnd' | 'id'>>,
  ): Promise<void> {
    const computedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.driverScore.deleteMany({ where: { periodStart, driverId: { notIn: rows.map((r) => r.driverId) } } }),
      ...rows.map((r) =>
        this.prisma.driverScore.upsert({
          where: { driverId_periodStart: { driverId: r.driverId, periodStart } },
          create: { ...r, periodStart, periodEnd, computedAt },
          update: { ...r, periodEnd, computedAt },
        }),
      ),
    ]);
  }

  /** D-141 — the most recently computed period (max `periodEnd`, then the longest/newest start). */
  latestPeriod(): Promise<{ periodStart: Date; periodEnd: Date } | null> {
    return this.prisma.driverScore.findFirst({
      orderBy: [{ periodEnd: 'desc' }, { periodStart: 'asc' }],
      select: { periodStart: true, periodEnd: true },
    });
  }

  /** Every `DriverScore` row of the period that starts on `periodStart`. */
  scorecard(periodStart: Date): Promise<DriverScore[]> {
    return this.prisma.driverScore.findMany({
      where: { periodStart },
      orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { milesDriven: 'desc' }, { driverId: 'asc' }],
    });
  }
}
