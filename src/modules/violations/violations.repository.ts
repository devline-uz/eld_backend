import { Injectable } from '@nestjs/common';
import type { HosViolation, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export type ViolationWithDriver = HosViolation & {
  driver: { id: string; firstName: string; lastName: string; assignedVehicleId: string | null };
};

/** B-6 — every database call of the fleet violation list and the manual resolve. */
@Injectable()
export class ViolationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(where: Prisma.HosViolationWhereInput, page: number, limit: number) {
    const [items, total] = await Promise.all([
      this.prisma.hosViolation.findMany({
        where,
        include: { driver: { select: { id: true, firstName: true, lastName: true, assignedVehicleId: true } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.hosViolation.count({ where }),
    ]);
    return { items: items as ViolationWithDriver[], total };
  }

  findById(id: string): Promise<HosViolation | null> {
    return this.prisma.hosViolation.findUnique({ where: { id } });
  }

  /**
   * Resolves only a row that is still OPEN, atomically — two concurrent resolves cannot both
   * win. Touches HosViolation only; no EldEvent / DailyLog column is ever written (§23).
   */
  async resolveIfOpen(id: string, data: { resolvedAt: Date; resolvedById: string; resolutionNote: string }): Promise<boolean> {
    const result = await this.prisma.hosViolation.updateMany({
      where: { id, status: 'OPEN' },
      data: { status: 'RESOLVED', ...data },
    });
    return result.count === 1;
  }

  /** The active record at or before the violation: which unit and where (display only). */
  findContextEvent(driverId: string, at: Date) {
    return this.prisma.eldEvent.findFirst({
      where: { driverId, recordStatus: 1, eventDateTime: { lte: at } },
      orderBy: [{ eventDateTime: 'desc' }, { eventSequenceId: 'desc' }],
      select: { vehicleId: true, locationName: true },
    });
  }

  findVehicles(ids: string[]) {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: { id: true, unitNumber: true } });
  }
}
