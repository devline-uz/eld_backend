import { Injectable } from '@nestjs/common';
import type { Prisma, Vehicle } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { applyOdometerOffsetMi, computeOdometerOffsetMi } from '../../common/units/odometer';
import { DriversRepository } from '../drivers/drivers.repository';
import {
  AssignDriverDto,
  CalibrateOdometerDto,
  CreateVehicleDto,
  ImportVehiclesDto,
  UpdateVehicleDto,
  VehicleListQueryDto,
} from './dto/vehicles.dto';
import { VehiclesRepository } from './vehicles.repository';

const SORTABLE_FIELDS = ['unitNumber', 'vin', 'make', 'model', 'status', 'createdAt'] as const;

export interface ImportSummary {
  imported: number;
  updated: number;
  failed: Array<{ index: number; error: string }>;
}

/**
 * TZ §5.3 / §4.3 — vehicle (unit) CRUD plus the odometer calibration flow. Driver assignment
 * lives here (not on `DriversController`) because the out-of-service block (hard rule: a
 * `Vehicle.status = OUT_OF_SERVICE` refuses assignment) is a *vehicle* invariant; this keeps
 * the module dependency one-directional (Vehicles -> Drivers, never the reverse).
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly vehicles: VehiclesRepository,
    private readonly drivers: DriversRepository,
  ) {}

  async list(query: VehicleListQueryDto): Promise<OffsetPage<Vehicle>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { unitNumber: 'asc' });
    const { items, total } = await this.vehicles.list({ status: query.status, q: query.q }, query.page, query.limit, orderBy);
    return toOffsetPage(items, total, query.page, query.limit);
  }

  async get(id: string): Promise<Vehicle> {
    const vehicle = await this.vehicles.findById({ id });
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404);
    return vehicle;
  }

  async create(dto: CreateVehicleDto): Promise<Vehicle> {
    const [byUnit, byVin] = await Promise.all([
      this.vehicles.findByUnitNumber(dto.unitNumber),
      this.vehicles.findByVin(dto.vin),
    ]);
    if (byUnit) throw AppException.conflict(`Unit "${dto.unitNumber}" already exists.`);
    if (byVin) throw AppException.conflict(`VIN "${dto.vin}" already exists.`);
    return this.vehicles.create(this.toCreateInput(dto));
  }

  async update(id: string, dto: UpdateVehicleDto): Promise<Vehicle> {
    await this.get(id);
    return this.vehicles.update({ id }, this.toUpdateInput(dto));
  }

  /**
   * Soft-delete only (never a hard `DELETE`) — see bugs.md B-009: Postgres's FK
   * `ON DELETE SET NULL` from `EldEvent` needs `UPDATE` on `EldEvent`, which the append-only
   * hardening migration revokes fleet-wide. A plain `status` flip never touches `EldEvent` and
   * is also the correct behavior on its own merits: a unit with historical ELD events must
   * never be dropped from the fleet table.
   */
  async remove(id: string): Promise<Vehicle> {
    await this.get(id);
    const driver = await this.drivers.findOne({ assignedVehicleId: id });
    if (driver) await this.drivers.update({ id: driver.id }, { assignedVehicle: { disconnect: true } });
    return this.vehicles.update({ id }, { status: 'INACTIVE' });
  }

  /**
   * TZ §4.3 step 4 — recalibration. `dto.odometerMi` is the true dash value the user just
   * read; the offset is only recomputed once a device reading exists to calibrate against
   * (`deviceOdometerMi`) — before that, the first PT30 event does the initial calibration
   * (ingest, Phase 3). Always audited via `@Audit` on the controller (hard rule).
   */
  async calibrateOdometer(id: string, dto: CalibrateOdometerDto): Promise<Vehicle> {
    const vehicle = await this.get(id);
    if (vehicle.deviceOdometerMi == null) {
      // No device reading yet to calibrate against — just record the dash value.
      return this.vehicles.update({ id }, { odometerMi: dto.odometerMi });
    }
    const odometerOffsetMi = computeOdometerOffsetMi({
      odometerMi: dto.odometerMi,
      deviceOdometerMi: vehicle.deviceOdometerMi,
    });
    return this.vehicles.update(
      { id },
      { odometerMi: dto.odometerMi, odometerOffsetMi, odometerCalibratedAt: new Date() },
    );
  }

  /** Convenience read matching the formula in TZ §4.3: `true = device + offset`. */
  trueOdometerMi(vehicle: Vehicle): number | null {
    if (vehicle.deviceOdometerMi == null) return vehicle.odometerMi;
    return applyOdometerOffsetMi(vehicle.deviceOdometerMi, vehicle.odometerOffsetMi);
  }

  /** Hard rule — an `OUT_OF_SERVICE` unit blocks driver assignment. */
  async assignDriver(vehicleId: string, dto: AssignDriverDto): Promise<Vehicle> {
    const vehicle = await this.get(vehicleId);
    if (vehicle.status === 'OUT_OF_SERVICE') {
      throw new AppException(ERROR_CODES.VEHICLE_OUT_OF_SERVICE, 'Vehicle is out of service and cannot be assigned a driver.', 409);
    }
    const driver = await this.drivers.findById({ id: dto.driverId });
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    if (driver.assignedVehicleId === vehicleId) return vehicle;
    try {
      await this.drivers.update({ id: dto.driverId }, { assignedVehicle: { connect: { id: vehicleId } } });
    } catch {
      throw AppException.conflict('Vehicle is already assigned to another driver.');
    }
    return vehicle;
  }

  async unassignDriver(vehicleId: string): Promise<Vehicle> {
    const vehicle = await this.get(vehicleId);
    const driver = await this.drivers.findOne({ assignedVehicleId: vehicleId });
    if (driver) await this.drivers.update({ id: driver.id }, { assignedVehicle: { disconnect: true } });
    return vehicle;
  }

  async exportAll(): Promise<CreateVehicleDto[]> {
    return (await this.vehicles.listAll()).map((v) => this.toExportRow(v));
  }

  /** Upserts by `unitNumber` (falls back to `vin`) so re-importing an export is idempotent. */
  async importMany(dto: ImportVehiclesDto): Promise<ImportSummary> {
    const summary: ImportSummary = { imported: 0, updated: 0, failed: [] };
    for (let index = 0; index < dto.vehicles.length; index += 1) {
      const row = dto.vehicles[index];
      try {
        const existing = (await this.vehicles.findByUnitNumber(row.unitNumber)) ?? (await this.vehicles.findByVin(row.vin));
        if (existing) {
          await this.vehicles.update({ id: existing.id }, this.toUpdateInput(row));
          summary.updated += 1;
        } else {
          await this.vehicles.create(this.toCreateInput(row));
          summary.imported += 1;
        }
      } catch (err) {
        summary.failed.push({ index, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    return summary;
  }

  private toCreateInput(dto: CreateVehicleDto): Prisma.VehicleCreateInput {
    return {
      unitNumber: dto.unitNumber,
      vin: dto.vin,
      make: dto.make,
      model: dto.model,
      year: dto.year,
      licensePlate: dto.licensePlate,
      plateState: dto.plateState,
      fuelType: dto.fuelType,
      sleeperBerth: dto.sleeperBerth,
      odometerMi: dto.odometerMi,
      busType: dto.busType,
      notes: dto.notes,
    };
  }

  private toUpdateInput(dto: UpdateVehicleDto): Prisma.VehicleUpdateInput {
    return {
      ...(dto.unitNumber !== undefined && { unitNumber: dto.unitNumber }),
      ...(dto.vin !== undefined && { vin: dto.vin }),
      ...(dto.make !== undefined && { make: dto.make }),
      ...(dto.model !== undefined && { model: dto.model }),
      ...(dto.year !== undefined && { year: dto.year }),
      ...(dto.licensePlate !== undefined && { licensePlate: dto.licensePlate }),
      ...(dto.plateState !== undefined && { plateState: dto.plateState }),
      ...(dto.fuelType !== undefined && { fuelType: dto.fuelType }),
      ...(dto.sleeperBerth !== undefined && { sleeperBerth: dto.sleeperBerth }),
      ...(dto.busType !== undefined && { busType: dto.busType }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.status !== undefined && { status: dto.status }),
    };
  }

  private toExportRow(v: Vehicle): CreateVehicleDto {
    return {
      unitNumber: v.unitNumber,
      vin: v.vin,
      make: v.make ?? undefined,
      model: v.model ?? undefined,
      year: v.year ?? undefined,
      licensePlate: v.licensePlate ?? undefined,
      plateState: v.plateState ?? undefined,
      fuelType: v.fuelType,
      sleeperBerth: v.sleeperBerth,
      odometerMi: v.odometerMi,
      busType: v.busType ?? undefined,
      notes: v.notes ?? undefined,
    };
  }
}
