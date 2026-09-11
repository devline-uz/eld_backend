import { Injectable } from '@nestjs/common';
import type { Driver, EldEvent, Prisma, UnidentifiedSegment } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { EVENT_TYPE, LOGIN_CODE } from '../ingest/event-codes';
import { PrismaService } from '../../core/prisma/prisma.service';

export type UnidentifiedTx = Prisma.TransactionClient;

/** TZ §5.9 / §7.4 — every database call of the unidentified-driving workflow. */
@Injectable()
export class UnidentifiedRepository extends BaseRepository<
  UnidentifiedSegment,
  Prisma.UnidentifiedSegmentWhereInput,
  Prisma.UnidentifiedSegmentWhereUniqueInput,
  Prisma.UnidentifiedSegmentCreateInput,
  Prisma.UnidentifiedSegmentUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    UnidentifiedSegment,
    Prisma.UnidentifiedSegmentWhereInput,
    Prisma.UnidentifiedSegmentWhereUniqueInput,
    Prisma.UnidentifiedSegmentCreateInput,
    Prisma.UnidentifiedSegmentUpdateInput
  > {
    return this.prisma.unidentifiedSegment;
  }

  runInTransaction<T>(fn: (tx: UnidentifiedTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: 30_000, maxWait: 10_000 });
  }

  findSegment(id: string): Promise<UnidentifiedSegment | null> {
    return this.prisma.unidentifiedSegment.findUnique({ where: { id } });
  }

  async listSegments(where: Prisma.UnidentifiedSegmentWhereInput, page: number, limit: number) {
    const [items, total] = await Promise.all([
      this.prisma.unidentifiedSegment.findMany({
        where,
        orderBy: { startAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.unidentifiedSegment.count({ where }),
    ]);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  /**
   * §395.32 / §7.4 rule 2 — a driver may only claim unidentified driving recorded on a unit
   * they actually operated: their current assignment, or an open (not logged-out) LOGIN
   * session on that unit at the time of the segment. Without this, any driver token could
   * absorb another driver's unidentified driving and empty it out of that driver's log.
   */
  async hasDriverVehicleAssociation(driverId: string, vehicleId: string, at: Date): Promise<boolean> {
    const driver = await this.prisma.driver.findUnique({
      where: { id: driverId },
      select: { assignedVehicleId: true },
    });
    if (driver?.assignedVehicleId === vehicleId) return true;
    const lastLogin = await this.prisma.eldEvent.findFirst({
      where: {
        vehicleId,
        driverId,
        eventType: EVENT_TYPE.LOGIN_LOGOUT,
        eventDateTime: { lte: at },
      },
      orderBy: [{ eventDateTime: 'desc' }, { id: 'desc' }],
      select: { eventCode: true },
    });
    return lastLogin?.eventCode === LOGIN_CODE.LOGIN;
  }

  findDriver(driverId: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { id: driverId } });
  }

  findEventsByIds(ids: bigint[]): Promise<EldEvent[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.eldEvent.findMany({
      where: { id: { in: ids } },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  }

  /** Records appended on top of `ids` — the assignment copies and the inactive markers. */
  findSupersedingEvents(ids: bigint[]): Promise<EldEvent[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.eldEvent.findMany({
      where: { supersedesId: { in: ids } },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  }

  findDriverEventsAfter(driverId: string, at: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId, recordStatus: 1, eventType: 1, eventDateTime: { gt: at } },
      orderBy: { eventDateTime: 'asc' },
      take: 1,
    });
  }

  findDriverEventsBefore(driverId: string, at: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId, recordStatus: 1, eventType: 1, eventDateTime: { lte: at } },
      orderBy: { eventDateTime: 'desc' },
      take: 1,
    });
  }

  updateSegment(id: string, data: Prisma.UnidentifiedSegmentUpdateInput): Promise<UnidentifiedSegment> {
    return this.prisma.unidentifiedSegment.update({ where: { id }, data });
  }
}
