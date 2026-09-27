import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { MALFUNCTION_EVENT_CODE } from '../ingest/event-codes';
import { MobileRepository } from './mobile.repository';
import { DeviceHealthRepository } from './device-health.repository';

const UNIDENTIFIED_WINDOW_DAYS = 8;

export interface DeviceHealthCode {
  kind: 'malfunction' | 'diagnostic';
  code: string;
}

/**
 * TZ §7.7 / §7.8 / §5.9 / §8.6 point 5 — `GET /mobile/device-health` (M-20/P-12). Read-only:
 * everything the app's device-health screen needs about the driver's assigned vehicle/device,
 * assembled from existing tables (no new writes, no new alerts).
 */
@Injectable()
export class DeviceHealthService {
  constructor(
    private readonly repo: MobileRepository,
    private readonly health: DeviceHealthRepository,
  ) {}

  async get(driverId: string, now: Date = new Date()) {
    const driver = await this.repo.findDriver(driverId);
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId });

    const vehicleId = driver.assignedVehicleId;
    const device = vehicleId ? await this.health.findDeviceByVehicle(vehicleId) : null;
    const since = new Date(now.getTime() - UNIDENTIFIED_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [events, pendingSegments, hosSnapshot] = await Promise.all([
      device ? this.health.findMalfunctionEvents(device.id) : Promise.resolve([]),
      this.health.findPendingUnidentifiedSegments(vehicleId, driverId, since),
      this.health.findHosSnapshot(driverId),
    ]);

    return {
      vehicleId: vehicleId ?? null,
      device: device
        ? {
            id: device.id,
            serial: device.serial,
            firmware: device.firmware,
            bleState: device.bleState,
            storedEventsCount: device.storedEventsCount,
            lastDeviceStatusAt: device.lastSeenAt,
          }
        : null,
      activeCodes: activeMalfunctionAndDiagnosticCodes(events),
      unidentified: {
        windowDays: UNIDENTIFIED_WINDOW_DAYS,
        pendingCount: pendingSegments.length,
        /** Same PENDING-on-this-vehicle pool the driver can answer "was this you?" on
         *  (`POST /unidentified/:id/confirm`, §7.4 rule 2) — there is no separate
         *  "confirmation request" table, the pending segment IS the request. */
        pendingConfirmationRequestIds: pendingSegments.map((s) => s.id),
      },
      hosDrift: hosSnapshot
        ? {
            computedAt: hosSnapshot.computedAt,
            lastComparedAt: hosSnapshot.lastComparedAt,
            maxDriftSec: hosSnapshot.maxDriftSec,
            driftAlerted: hosSnapshot.driftAlerted,
          }
        : null,
    };
  }
}

/** §7.8 — a code is "active" when its latest eventType-7 record for that code is logged
 *  (1/3) and nothing later cleared it (2/4). Malfunction and diagnostic codes never share a
 *  string value (`MALFUNCTION` uses letters, `DIAGNOSTIC` uses digits), so one map is safe. */
function activeMalfunctionAndDiagnosticCodes(events: { eventCode: number; malfunctionCode: string | null; diagnosticCode: string | null }[]): DeviceHealthCode[] {
  const state = new Map<string, DeviceHealthCode>();
  for (const e of events) {
    const code = e.malfunctionCode ?? e.diagnosticCode;
    if (!code) continue;
    if (e.eventCode === MALFUNCTION_EVENT_CODE.MALFUNCTION_LOGGED) state.set(code, { kind: 'malfunction', code });
    else if (e.eventCode === MALFUNCTION_EVENT_CODE.MALFUNCTION_CLEARED) state.delete(code);
    else if (e.eventCode === MALFUNCTION_EVENT_CODE.DIAGNOSTIC_LOGGED) state.set(code, { kind: 'diagnostic', code });
    else if (e.eventCode === MALFUNCTION_EVENT_CODE.DIAGNOSTIC_CLEARED) state.delete(code);
  }
  return [...state.values()];
}
