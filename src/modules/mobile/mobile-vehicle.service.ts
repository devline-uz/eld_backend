import { Injectable, Logger } from '@nestjs/common';
import { EditorType } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { AuditRepository } from '../audit/audit.repository';
import type { SelectVehicleDto } from './dto/mobile-fleet-ops.dto';
import { MobileFleetOpsRepository, VehicleWithDevice } from './mobile-fleet-ops.repository';

/** M-03 "select vehicle" response — the SAME shape `GET /mobile/bootstrap` uses for
 * `vehicle`, so the app can drop the result straight into its cached bootstrap state. */
export interface MobileVehicleShape {
  id: string;
  unitNumber: string;
  vin: string;
  make: string | null;
  model: string | null;
  year: number | null;
  sleeperBerth: boolean;
  status: string;
  odometerMi: number;
}

/**
 * TZ mobile/tz.md §21.1 MB-2, screen M-03 — the app's "select your truck" step.
 *
 * `Device<->Vehicle` binding lives only on `Device.vehicleId` (untouched here); this only
 * ever writes `Driver.assignedVehicleId`, and only for the CALLING driver.
 */
@Injectable()
export class MobileVehicleService {
  private readonly logger = new Logger(MobileVehicleService.name);

  constructor(
    private readonly repo: MobileFleetOpsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async availableVehicles(driverId: string) {
    const vehicles = await this.repo.findAvailableVehicles(driverId);
    return vehicles.map(toAvailableVehicleShape);
  }

  async select(driverId: string, dto: SelectVehicleDto, actor: ContextUser): Promise<MobileVehicleShape> {
    const vehicle = await this.repo.findVehicleWithDevice(dto.vehicleId);
    if (!vehicle) {
      throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId: dto.vehicleId });
    }
    if (vehicle.status === 'OUT_OF_SERVICE') {
      throw new AppException(ERROR_CODES.VEHICLE_OUT_OF_SERVICE, 'This unit is out of service and cannot be selected.', 422, {
        vehicleId: dto.vehicleId,
      });
    }

    const holder = await this.repo.findVehicleHolder(dto.vehicleId);
    if (holder && holder.id !== driverId && holder.status === 'ACTIVE') {
      throw AppException.conflict('This unit is already assigned to another active driver.', {
        vehicleId: dto.vehicleId,
        holderId: holder.id,
      });
    }
    const staleHolderId = holder && holder.id !== driverId ? holder.id : null;

    await this.repo.assignVehicle(driverId, dto.vehicleId, staleHolderId);

    await this.writeAudit(actor, driverId, dto.vehicleId);

    return toBootstrapVehicleShape(vehicle);
  }

  private async writeAudit(actor: ContextUser, driverId: string, vehicleId: string): Promise<void> {
    const ctx = RequestContext.get();
    try {
      await this.audit.insert({
        actorId: actor.id,
        actorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
        action: 'DRIVER_VEHICLE_SELECTED',
        objectType: 'Driver',
        objectId: driverId,
        after: { vehicleId },
        detail: 'Driver selected/switched their assigned unit from the app (mobile/tz.md M-03).',
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, driverId, vehicleId }, 'Failed to write the vehicle-selection audit entry');
    }
  }
}

function toAvailableVehicleShape(vehicle: VehicleWithDevice) {
  return {
    id: vehicle.id,
    unitNumber: vehicle.unitNumber,
    make: vehicle.make,
    model: vehicle.model,
    deviceSerial: vehicle.device?.serial ?? null,
  };
}

function toBootstrapVehicleShape(vehicle: VehicleWithDevice): MobileVehicleShape {
  return {
    id: vehicle.id,
    unitNumber: vehicle.unitNumber,
    vin: vehicle.vin,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    sleeperBerth: vehicle.sleeperBerth,
    status: vehicle.status,
    odometerMi: vehicle.odometerMi,
  };
}

export { toAvailableVehicleShape };
