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

  /** BUG-003 — `HosViolation` rows matching `where`, counted per driver. */
  async countByDriver(where: Prisma.HosViolationWhereInput): Promise<Map<string, number>> {
    const rows = await this.prisma.hosViolation.groupBy({ by: ['driverId'], where, _count: { _all: true } });
    return new Map(rows.map((row) => [row.driverId, row._count._all]));
  }

  findById(id: string): Promise<HosViolation | null> {
    return this.prisma.hosViolation.findUnique({ where: { id } });
  }

  /**
   * Resolves only a row that is still OPEN, atomically — two concurrent resolves cannot both
   * win. No EldEvent is ever written (§23). CODE-069 — in the same transaction the day's
   * `DailyLog` violation flags are recounted from the OPEN rows left, so the RODS header (the
   * certification card, the roster, the activity report) stops flagging a resolved day.
   */
  async resolveIfOpen(id: string, data: { resolvedAt: Date; resolvedById: string; resolutionNote: string }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.hosViolation.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: 'RESOLVED', ...data },
      });
      if (result.count !== 1) return false;
      const row = await tx.hosViolation.findUnique({ where: { id }, select: { driverId: true, logDate: true } });
      if (row) {
        const open = await tx.hosViolation.count({ where: { driverId: row.driverId, logDate: row.logDate, status: 'OPEN' } });
        await tx.dailyLog.updateMany({
          where: { driverId: row.driverId, logDate: row.logDate },
          data: { hasViolation: open > 0, violationCount: open },
        });
      }
      return true;
    });
  }

  /** The active record at or before the violation: which unit and where (display only). */
  findContextEvent(driverId: string, at: Date) {
    return this.prisma.eldEvent.findFirst({
      where: { driverId, recordStatus: 1, eventDateTime: { lte: at } },
      orderBy: [{ eventDateTime: 'desc' }, { eventSequenceId: 'desc' }],
      select: { vehicleId: true, locationName: true, locationPrecisionMi: true },
    });
  }

  findVehicles(ids: string[]) {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: { id: true, unitNumber: true } });
  }
}
