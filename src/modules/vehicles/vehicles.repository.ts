import { Injectable } from '@nestjs/common';
import type { Prisma, Vehicle } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface VehicleListFilter {
  status?: Vehicle['status'];
  q?: string;
  /** A group id, or `'none'` for units in no group. */
  groupId?: string;
}

export interface VehicleListPage {
  items: Vehicle[];
  total: number;
}

@Injectable()
export class VehiclesRepository extends BaseRepository<
  Vehicle,
  Prisma.VehicleWhereInput,
  Prisma.VehicleWhereUniqueInput,
  Prisma.VehicleCreateInput,
  Prisma.VehicleUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Vehicle,
    Prisma.VehicleWhereInput,
    Prisma.VehicleWhereUniqueInput,
    Prisma.VehicleCreateInput,
    Prisma.VehicleUpdateInput
  > {
    return this.prisma.vehicle;
  }

  findByUnitNumber(unitNumber: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findUnique({ where: { unitNumber } });
  }

  findByVin(vin: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findUnique({ where: { vin } });
  }

  async list(
    filter: VehicleListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<VehicleListPage> {
    const where: Prisma.VehicleWhereInput = {
      ...(filter.status && { status: filter.status }),
      ...(filter.groupId && { groupId: filter.groupId === 'none' ? null : filter.groupId }),
      ...(filter.q && {
        OR: [
          { unitNumber: { contains: filter.q, mode: 'insensitive' } },
          { vin: { contains: filter.q, mode: 'insensitive' } },
          { make: { contains: filter.q, mode: 'insensitive' } },
          { model: { contains: filter.q, mode: 'insensitive' } },
          { licensePlate: { contains: filter.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.vehicle.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.vehicle.count({ where }),
    ]);
    return { items, total };
  }

  async groupExists(id: string): Promise<boolean> {
    return (await this.prisma.vehicleGroup.count({ where: { id } })) > 0;
  }

  listAll(): Promise<Vehicle[]> {
    return this.prisma.vehicle.findMany({ orderBy: { unitNumber: 'asc' } });
  }

  /**
   * TZ §5.10 hard rule support — ids of OPEN + CRITICAL defects on this unit. Queried directly
   * against the `Defect` table (not via `DefectsRepository`) to avoid a `VehiclesModule <->
   * ServiceModule` import cycle; `VehiclesModule` stays the leaf the same way it already is for
   * `DriversModule`.
   */
  findOpenCriticalDefectIds(vehicleId: string): Promise<Array<{ id: string }>> {
    return this.prisma.defect.findMany({
      where: { vehicleId, status: 'OPEN', severity: 'CRITICAL' },
      select: { id: true },
    });
  }

  /**
   * §20 B-5 — "Unit activity" feed. Reads the `AuditLog` rows already recorded against this
   * vehicle plus its DVIR submissions directly (not via `DefectsModule`/an audit service) for
   * the same acyclic-graph reason as `findOpenCriticalDefectIds` above: `VehiclesModule` stays
   * the leaf `DevicesModule`/`ServiceModule` depend on, never the reverse.
   */
  findAuditRows(vehicleId: string, limit = 100) {
    return this.prisma.auditLog.findMany({
      where: { objectType: 'Vehicle', objectId: vehicleId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  findDvirRows(vehicleId: string, limit = 100) {
    return this.prisma.dvir.findMany({
      where: { vehicleId },
      orderBy: { submittedAt: 'desc' },
      take: limit,
      include: { driver: { select: { firstName: true, lastName: true } } },
    });
  }

  /**
   * §20 B-69 `pairDevices` import option — queried directly against `Device` (not via
   * `DevicesModule`, which already depends one-directionally on `VehiclesModule`; the reverse
   * import would be a cycle). Mirrors `findOpenCriticalDefectIds`.
   */
  findDeviceBySerial(serial: string) {
    return this.prisma.device.findUnique({ where: { serial } });
  }

  pairDevice(deviceId: string, vehicleId: string) {
    return this.prisma.device.update({
      where: { id: deviceId },
      data: { vehicleId, status: 'ASSIGNED', pairedAt: new Date() },
    });
  }

  /**
   * §20 B-4 / telemetry read — queried directly against `TelemetryPoint` rather than via
   * `TelemetryModule` (`TelemetryModule -> DtcModule -> VehiclesModule` would cycle). Same
   * acyclic-graph pattern as `findOpenCriticalDefectIds`.
   */
  findTelemetryRange(vehicleId: string, from: Date, to: Date) {
    return this.prisma.telemetryPoint.findMany({
      where: { vehicleId, time: { gte: from, lt: to } },
      orderBy: { time: 'asc' },
    });
  }

  findTelemetryRecent(vehicleId: string, limit: number, from?: Date, to?: Date) {
    return this.prisma.telemetryPoint.findMany({
      where: {
        vehicleId,
        ...((from || to) && { time: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
      },
      orderBy: { time: 'desc' },
      take: limit,
    });
  }
}
