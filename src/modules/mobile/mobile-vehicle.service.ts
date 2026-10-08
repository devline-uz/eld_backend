import { Injectable, Logger } from '@nestjs/common';
import { EditorType } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { AuditRepository } from '../audit/audit.repository';
import type { AvailableVehiclesQueryDto, ReleaseVehicleDto, SelectVehicleDto } from './dto/mobile-fleet-ops.dto';
import { MobileFleetOpsRepository, VehicleWithDevice } from './mobile-fleet-ops.repository';
import { MobileRepository } from './mobile.repository';
import { RodsLoginRecorder } from '../logs/rods-login-recorder';

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
  /** MR-21 — the PT30 bound to this unit (`Device.vehicleId`), or null. */
  device: { id: string; serial: string; model: string } | null;
}

export interface ReleaseVehicleResult {
  released: true;
  vehicleId: string;
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
    private readonly mobileRepo: MobileRepository,
    private readonly loginRecords: RodsLoginRecorder,
  ) {}

  async availableVehicles(driverId: string, query: AvailableVehiclesQueryDto = {}) {
    const vehicles = await this.repo.findAvailableVehicles(driverId, query);
    return vehicles.map(toAvailableVehicleShape);
  }

  /**
   * MR-2 — the driver gives up their unit so it shows up in other drivers' `available-vehicles`.
   * Also ends the driver's active co-driver pairing when it is on that unit (the pairing is about
   * the unit; leaving it dangling would leave the partner "paired" to nobody's truck).
   * Idempotent on `clientId`: a replay returns the first answer instead of 409.
   */
  async release(driverId: string, dto: ReleaseVehicleDto, actor: ContextUser): Promise<ReleaseVehicleResult> {
    if (dto.clientId) {
      const prior = await this.mobileRepo.findSyncedByClientId(driverId, dto.clientId);
      // The ledger is shared by sync / chat / support: a clientId recorded for another operation
      // must not be answered with that operation's stored result.
      if (prior && prior.type !== 'release_vehicle') {
        throw AppException.conflict('clientId already used by another operation.', { clientId: dto.clientId });
      }
      if (prior?.status === 'ACCEPTED' && prior.result) return prior.result as unknown as ReleaseVehicleResult;
    }

    const driver = await this.mobileRepo.findDriver(driverId);
    const vehicleId = driver?.assignedVehicleId;
    if (!vehicleId) {
      throw new AppException(ERROR_CODES.NO_ASSIGNED_VEHICLE, 'You have no assigned vehicle to release.', 409);
    }

    const pairing = await this.mobileRepo.findActivePairing(driverId);
    const endPairingId = pairing && pairing.vehicleId === vehicleId ? pairing.id : null;
    await this.repo.releaseVehicle(driverId, endPairingId, new Date());
    // D-130 — leaving the unit ends the ELD session on it: §395 Appendix A 4.5.1.5 logout record.
    await this.loginRecords.logout(driverId, 'RELEASE_VEHICLE', { onlyVehicleId: vehicleId });

    const result: ReleaseVehicleResult = { released: true, vehicleId };
    if (dto.clientId) {
      await this.mobileRepo.recordSyncedResult(driverId, dto.clientId, 'release_vehicle', new Date(), 'ACCEPTED', null, { ...result });
    }

    try {
      await this.audit.insert({
        actorId: actor.id,
        actorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
        action: 'DRIVER_VEHICLE_RELEASED',
        objectType: 'Driver',
        objectId: driverId,
        before: { vehicleId },
        after: { vehicleId: null, pairingEnded: endPairingId, reason: dto.reason ?? null },
        detail: 'Driver released their assigned unit from the app (MR-2).',
        ip: RequestContext.get()?.ip,
        userAgent: RequestContext.get()?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, driverId, vehicleId }, 'Failed to write the vehicle-release audit entry');
    }
    return result;
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
    // D-130 — authenticated driver on a unit = §395 Appendix A 4.5.1.5 login (an open login on
    // another unit is closed first); a replaced non-ACTIVE holder's open login on it is closed.
    if (staleHolderId) await this.loginRecords.logout(staleHolderId, 'STALE_HOLDER_REPLACED', { onlyVehicleId: dto.vehicleId });
    await this.loginRecords.login(driverId, dto.vehicleId, 'SELECT_VEHICLE');

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
    device: vehicle.device ? { id: vehicle.device.id, serial: vehicle.device.serial, model: vehicle.device.model } : null,
  };
}

export { toAvailableVehicleShape };
