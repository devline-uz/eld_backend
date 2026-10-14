import { Injectable } from '@nestjs/common';
import type { MaintenanceSchedule, MaintenanceScheduleStatus, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface ScheduleListFilter {
  vehicleId?: string;
  enabled?: boolean;
  status?: MaintenanceScheduleStatus;
}

export interface ScheduleListPage {
  items: MaintenanceSchedule[];
  total: number;
}

@Injectable()
export class MaintenanceSchedulesRepository extends BaseRepository<
  MaintenanceSchedule,
  Prisma.MaintenanceScheduleWhereInput,
  Prisma.MaintenanceScheduleWhereUniqueInput,
  Prisma.MaintenanceScheduleCreateInput,
  Prisma.MaintenanceScheduleUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    MaintenanceSchedule,
    Prisma.MaintenanceScheduleWhereInput,
    Prisma.MaintenanceScheduleWhereUniqueInput,
    Prisma.MaintenanceScheduleCreateInput,
    Prisma.MaintenanceScheduleUpdateInput
  > {
    return this.prisma.maintenanceSchedule;
  }

  async list(filter: ScheduleListFilter, page: number, limit: number): Promise<ScheduleListPage> {
    const where: Prisma.MaintenanceScheduleWhereInput = {
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.enabled !== undefined && { enabled: filter.enabled }),
      ...(filter.status && { status: filter.status }),
    };
    const [items, total] = await Promise.all([
      this.prisma.maintenanceSchedule.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.maintenanceSchedule.count({ where }),
    ]);
    return { items, total };
  }

  /** Schedules joined to their vehicle's current odometer, for due/overdue detection (BullMQ
   * `maintenance-due` job and the `dueOnly` list filter). CODE-071 — only live work is due: a
   * CANCELLED schedule and a schedule on a soft-deleted unit never alert. `enabled` defaults to
   * the enabled schedules; the list filter may ask for the disabled ones instead. */
  listEnabledWithVehicle(enabled = true) {
    return this.prisma.maintenanceSchedule.findMany({
      where: { enabled, status: { not: 'CANCELLED' }, vehicle: { deletedAt: null } },
      include: { vehicle: { select: { id: true, unitNumber: true, odometerMi: true } } },
    });
  }
}
