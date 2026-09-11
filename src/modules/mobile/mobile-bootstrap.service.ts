import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import { toMobileShape } from '../hos-state/hos-drift';
import { LogsService } from '../logs/logs.service';
import { MobileRepository } from './mobile.repository';

/** §13.3 — what the app must retry-fetch/backoff on, mirrored into the bootstrap response. */
export const SYNC_CONFIG = {
  batchMaxChanges: 500,
  batchMaxBytes: 1024 * 1024,
  onlineIntervalSec: 60,
  onlineBatchThreshold: 50,
  /** §13.4 — exponential backoff while offline: 30s → 1m → 5m → 15m → 30m (cap). */
  offlineBackoffSec: [30, 60, 300, 900, 1800],
  localEventRetentionDays: 30,
  localInspectionRetentionDays: 8,
  syncBacklogWarnDays: 30,
  syncBacklogWarnBytes: 200 * 1024 * 1024,
} as const;

/**
 * TZ §11.8 / §13.2 — `GET /mobile/bootstrap`: everything the app needs on cold start, and
 * everything it must cache to keep working with zero connectivity (§8.6 point 4 for the
 * engine-version banner, §13.5 for the offline DOT-inspection packet).
 */
@Injectable()
export class MobileBootstrapService {
  constructor(
    private readonly repo: MobileRepository,
    private readonly hosRecalc: HosRecalcService,
    private readonly logs: LogsService,
  ) {}

  async bootstrap(driverId: string, now: Date = new Date()) {
    const driver = await this.repo.findDriver(driverId);
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId });

    const [carrier, vehicle, pairing, hos, inspection] = await Promise.all([
      this.repo.findCarrier(),
      driver.assignedVehicleId ? this.repo.findVehicle(driver.assignedVehicleId) : Promise.resolve(null),
      this.repo.findActivePairing(driverId),
      this.hosRecalc.computeCurrentState(driverId, now),
      this.logs.getInspectionPacket(driverId, now),
    ]);
    const device = vehicle ? await this.repo.findDeviceByVehicle(vehicle.id) : null;

    return {
      serverTime: now.toISOString(),
      hosEngineVersion: HOS_ENGINE_VERSION,
      driver: {
        id: driver.id,
        firstName: driver.firstName,
        lastName: driver.lastName,
        cdlNumber: driver.cdlNumber,
        cdlState: driver.cdlState,
        status: driver.status,
        homeTerminalName: driver.homeTerminalName,
        homeTerminalTimezone: driver.homeTerminalTimezone,
        hosRuleset: driver.hosRuleset,
        exceptions: {
          allowPersonalConveyance: driver.allowPersonalConveyance,
          allowYardMove: driver.allowYardMove,
          adverseDrivingEnabled: driver.adverseDrivingEnabled,
          shortHaulException: driver.shortHaulException,
          splitSleeperEnabled: driver.splitSleeperEnabled,
          eldExempt: driver.eldExempt,
          eldExemptReason: driver.eldExemptReason,
        },
        lastSyncAt: driver.lastSyncAt,
      },
      vehicle: vehicle
        ? {
            id: vehicle.id,
            unitNumber: vehicle.unitNumber,
            vin: vehicle.vin,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            sleeperBerth: vehicle.sleeperBerth,
            status: vehicle.status,
            odometerMi: vehicle.odometerMi,
          }
        : null,
      device: device
        ? {
            id: device.id,
            serial: device.serial,
            model: device.model,
            firmware: device.firmware,
            status: device.status,
            bleState: device.bleState,
            bleMacAddress: device.bleMacAddress,
            pairedAt: device.pairedAt,
            periodicConnectedSec: device.periodicConnectedSec,
            periodicDisconnectedMin: device.periodicDisconnectedMin,
          }
        : null,
      coDriver: pairing
        ? { pairingId: pairing.id, primaryDriverId: pairing.primaryDriverId, coDriverId: pairing.coDriverId, startedAt: pairing.startedAt }
        : null,
      carrier: carrier
        ? {
            name: carrier.name,
            dotNumber: carrier.dotNumber,
            timezone: carrier.timezone,
            hosRuleset: carrier.hosRuleset,
            distanceUnit: carrier.distanceUnit,
            allowPersonalConveyance: carrier.allowPersonalConveyance,
            allowYardMove: carrier.allowYardMove,
            eldIdentifier: carrier.eldIdentifier,
            erodsMode: carrier.erodsMode,
          }
        : null,
      hos: hos
        ? { computedAt: now.toISOString(), timezone: hos.timezone, state: toMobileShape(hos.state) }
        : null,
      /** §13.5 — cached locally; the app's inspection mode never calls the network again. */
      inspectionPacket: inspection,
      syncConfig: SYNC_CONFIG,
    };
  }
}
