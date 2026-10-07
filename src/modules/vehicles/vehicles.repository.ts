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

/** Thrown inside `saveWithDevice`'s transaction when the device was claimed by another live unit
 * between the service's pre-check and the write; the service maps it to `ELD_SERIAL_TAKEN`. */
export class EldSerialTakenError extends Error {
  constructor() {
    super('ELD device is already paired to another unit.');
    this.name = 'EldSerialTakenError';
  }
}

/** The vehicle row write `saveWithDevice` wraps — a create, or an update of one unit. */
export type VehicleWrite =
  | { create: Prisma.VehicleCreateInput }
  | { id: string; update: Prisma.VehicleUpdateInput };

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

  /** Live (not soft-deleted) unit only — `unitNumber` is unique among live rows via a partial
   * unique index (migration 20260927090000_soft_delete_partial_uniques), so a deleted unit's
   * number is free for reuse. Compared like the web does (B-97): trimmed, without the display
   * `#`, case-insensitively — `#101`, `101` and ` 101 ` are the same unit number. */
  findByUnitNumber(unitNumber: string): Promise<Vehicle | null> {
    const key = unitNumber.trim().replace(/^#/, '');
    return this.prisma.vehicle.findFirst({
      where: {
        deletedAt: null,
        OR: [
          { unitNumber: { equals: key, mode: 'insensitive' } },
          { unitNumber: { equals: `#${key}`, mode: 'insensitive' } },
        ],
      },
    });
  }

  /** Live (not soft-deleted) unit only — see `findByUnitNumber`. VINs are stored upper-cased (the
   * DTO normalises them); the lookup is case-insensitive anyway. */
  findByVin(vin: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findFirst({ where: { vin: { equals: vin.trim(), mode: 'insensitive' }, deletedAt: null } });
  }

  async list(
    filter: VehicleListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<VehicleListPage> {
    const where: Prisma.VehicleWhereInput = {
      deletedAt: null,
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
    return this.prisma.vehicle.findMany({ where: { deletedAt: null }, orderBy: { unitNumber: 'asc' } });
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

  /**
   * ELD serial lookup for `POST/PATCH /vehicles` `deviceId` — exact match first (`serial` is
   * `@unique`), then case-insensitive, with the holder's soft-delete marker so a device left on a
   * deleted unit counts as free.
   */
  async findDeviceForPairing(serial: string) {
    const include = { vehicle: { select: { id: true, deletedAt: true } } } as const;
    return (
      (await this.prisma.device.findUnique({ where: { serial }, include })) ??
      (await this.prisma.device.findFirst({ where: { serial: { equals: serial, mode: 'insensitive' } }, include }))
    );
  }

  /** The device currently paired to this unit (`Device.vehicleId` is `@@unique`), if any. */
  findDeviceByVehicleId(vehicleId: string) {
    return this.prisma.device.findUnique({ where: { vehicleId } });
  }

  /**
   * Another LIVE unit with the same plate in the same issuing state — compared trim- and
   * case-insensitively like the partial unique index `Vehicle_plate_state_live_key` (migration
   * 20261007090000_vehicle_plate_state_live_unique). Values are stored normalised (trim + upper,
   * `''` -> NULL), so an insensitive equals is enough; a NULL state only matches a NULL state.
   */
  findLiveByPlate(licensePlate: string, plateState: string | null, exceptVehicleId?: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findFirst({
      where: {
        deletedAt: null,
        licensePlate: { equals: licensePlate, mode: 'insensitive' },
        plateState: plateState === null ? null : { equals: plateState, mode: 'insensitive' },
        ...(exceptVehicleId && { id: { not: exceptVehicleId } }),
      },
    });
  }

  /**
   * Writes the vehicle row and moves its ELD pairing in ONE transaction. `deviceId` is the
   * device to pair (`null` = leave the unit with no device). Whatever other device the unit held
   * is released first (one device per unit, `Device_vehicleId_key`); the new device is claimed with
   * a conditional update that only matches when it is free, already ours, or left on a
   * soft-deleted unit — a concurrent claim by another live unit matches zero rows and rolls the
   * whole write back with `EldSerialTakenError`.
   */
  saveWithDevice(write: VehicleWrite, deviceId: string | null): Promise<Vehicle> {
    return this.prisma.$transaction(async (tx) => {
      const vehicle =
        'create' in write
          ? await tx.vehicle.create({ data: write.create })
          : await tx.vehicle.update({ where: { id: write.id }, data: write.update });
      await tx.device.updateMany({
        where: { vehicleId: vehicle.id, ...(deviceId && { id: { not: deviceId } }) },
        data: { vehicleId: null, status: 'UNASSIGNED', pairedAt: null },
      });
      if (deviceId) {
        const claimed = await tx.device.updateMany({
          where: {
            id: deviceId,
            OR: [{ vehicleId: null }, { vehicleId: vehicle.id }, { vehicle: { deletedAt: { not: null } } }],
          },
          data: { vehicleId: vehicle.id, status: 'ASSIGNED', pairedAt: new Date() },
        });
        if (claimed.count === 0) throw new EldSerialTakenError();
      }
      return vehicle;
    });
  }

  /** Soft delete frees the unit's ELD device for another unit. */
  releaseDevice(vehicleId: string) {
    return this.prisma.device.updateMany({
      where: { vehicleId },
      data: { vehicleId: null, status: 'UNASSIGNED', pairedAt: null },
    });
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
