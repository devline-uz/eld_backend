import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AppConfigService } from '../../core/config/config.service';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import { toMobileShape } from '../hos-state/hos-drift';
import { LogsService } from '../logs/logs.service';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
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
    private readonly config: AppConfigService,
    private readonly fleetOps: MobileFleetOpsRepository,
  ) {}

  async bootstrap(driverId: string, now: Date = new Date()) {
    const driver = await this.repo.findDriver(driverId);
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId });

    const [carrier, vehicle, pairing, hos, inspection, availableVehicles] = await Promise.all([
      this.repo.findCarrier(),
      driver.assignedVehicleId ? this.repo.findVehicle(driver.assignedVehicleId) : Promise.resolve(null),
      this.repo.findActivePairing(driverId),
      this.hosRecalc.computeCurrentState(driverId, now),
      this.logs.getInspectionPacket(driverId, now),
      // MB-2 (mobile/tz.md §21.1, screen M-03) — units this driver may pick from.
      this.fleetOps.findAvailableVehicles(driverId),
    ]);
    const device = vehicle ? await this.repo.findDeviceByVehicle(vehicle.id) : null;
    // MB-3 (mobile/tz.md §21.1, screens S-11/S-18/S-19) — the co-driver's own identity + duty
    // status, not just the pairing row ids the response already carried.
    const coDriverId = pairing ? (pairing.primaryDriverId === driverId ? pairing.coDriverId : pairing.primaryDriverId) : null;
    const [coDriver, coDriverStatus] = coDriverId
      ? await Promise.all([this.repo.findDriver(coDriverId), this.fleetOps.findLatestDutyStatus(coDriverId)])
      : [null, null];

    return {
      serverTime: now.toISOString(),
      hosEngineVersion: HOS_ENGINE_VERSION,
      driver: {
        id: driver.id,
        /** Mobile wave 4 (M-31 / D-120) — the ELD username (Appendix A 7.38): Driver ID line + phone-built eRODS file. */
        username: driver.username,
        firstName: driver.firstName,
        lastName: driver.lastName,
        cdlNumber: driver.cdlNumber,
        cdlState: driver.cdlState,
        /** MR-17 — contact details for the profile screen; `null` when not on file. */
        email: driver.email ?? null,
        phone: driver.phone ?? null,
        /** MR-16 — §395.1 exempt driver status (mirror of `exceptions.eldExempt`). */
        exemptDriverStatus: driver.eldExempt,
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
      coDriver:
        pairing && coDriver
          ? {
              pairingId: pairing.id,
              primaryDriverId: pairing.primaryDriverId,
              coDriverId: pairing.coDriverId,
              startedAt: pairing.startedAt,
              firstName: coDriver.firstName,
              lastName: coDriver.lastName,
              username: coDriver.username,
              currentStatus: coDriverStatus,
            }
          : null,
      /** MB-2 (M-03) — `{ id, unitNumber, make, model, deviceSerial }` per unit. */
      availableVehicles: availableVehicles.map((v) => ({
        id: v.id,
        unitNumber: v.unitNumber,
        make: v.make,
        model: v.model,
        deviceSerial: v.device?.serial ?? null,
      })),
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
            /** MR-16 — one line "street, city, ST zip" built from the carrier address; `null` if none on file. */
            mainOfficeAddress: formatMainOfficeAddress(carrier),
            /** MR-16 — ELD provider name (env `ELD_PROVIDER_NAME`, default "OneBook ELD"). */
            eldProvider: this.config.get('ELD_PROVIDER_NAME') ?? 'OneBook ELD',
            eldRegistrationId: carrier.eldRegistrationId ?? null,
            erodsMode: carrier.erodsMode,
          }
        : null,
      hos: hos
        ? { computedAt: now.toISOString(), timezone: hos.timezone, state: toMobileShape(hos.state) }
        : null,
      /** §13.5 — cached locally; the app's inspection mode never calls the network again. */
      inspectionPacket: inspection,
      syncConfig: SYNC_CONFIG,
      /** MB-19 — force-update banner (M-09). `null` when unconfigured, never a half-filled
       * object: an app must not show "update available" off bare defaults. */
      appUpdate: this.buildAppUpdate(),
    };
  }

  private buildAppUpdate() {
    const latestVersion = this.config.get('MOBILE_APP_LATEST_VERSION');
    const minVersion = this.config.get('MOBILE_APP_MIN_VERSION');
    if (!latestVersion && !minVersion) return null;
    return {
      latestVersion: latestVersion ?? null,
      minVersion: minVersion ?? null,
      notes: this.config.get('MOBILE_APP_RELEASE_NOTES') ?? null,
      storeUrl: {
        ios: this.config.get('MOBILE_APP_STORE_URL_IOS') ?? null,
        android: this.config.get('MOBILE_APP_STORE_URL_ANDROID') ?? null,
      },
    };
  }
}

function formatMainOfficeAddress(c: { addressLine1: string | null; city: string | null; state: string | null; zip: string | null }): string | null {
  const stateZip = [c.state, c.zip].filter(Boolean).join(' ');
  const parts = [c.addressLine1, c.city, stateZip].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(', ') : null;
}
