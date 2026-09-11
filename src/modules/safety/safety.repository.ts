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

  /** Raw counts feeding `computeDriverScore` for a period, per driver. */
  countsForDriver(driverId: string, from: Date, to: Date) {
    return this.prisma.safetyEvent.groupBy({
      by: ['type'],
      where: { driverId, occurredAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
  }

  upsertScore(driverId: string, periodStart: Date, periodEnd: Date, data: Omit<Prisma.DriverScoreCreateInput, 'driverId' | 'periodStart' | 'periodEnd'>): Promise<DriverScore> {
    return this.prisma.driverScore.upsert({
      where: { driverId_periodStart: { driverId, periodStart } },
      create: { driverId, periodStart, periodEnd, ...data },
      update: { periodEnd, ...data },
    });
  }

  scorecard(periodStart: Date, periodEnd: Date): Promise<DriverScore[]> {
    return this.prisma.driverScore.findMany({
      where: { periodStart, periodEnd },
      orderBy: { score: 'asc' },
    });
  }
}
