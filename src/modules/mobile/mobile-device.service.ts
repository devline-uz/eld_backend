import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { EditorType, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { AuditRepository } from '../audit/audit.repository';
import { normalizeMac, type ReportDeviceMacDto } from './dto/mobile-device.dto';
import { MobileDeviceRepository } from './mobile-device.repository';
import { MobileRepository } from './mobile.repository';

export type DeviceMacOutcome = 'STORED' | 'UNCHANGED';

export interface DeviceMacResult {
  deviceId: string;
  macAddress: string;
  outcome: DeviceMacOutcome;
}

/**
 * MG-BLE-1/2 (D-128) — the driver app REPORTS the BLE MAC it observed on the PT30 bound to the
 * driver's currently selected unit. The device<->vehicle binding stays back-office only
 * (`POST /devices/:id/pair`, `PATCH /devices/:id`); this never pairs, unpairs or re-binds.
 *
 *  - stored MAC empty  -> written (compare-and-set) + `DEVICE_MAC_REPORTED` audit, `STORED`;
 *  - stored MAC equal  -> no-op, `UNCHANGED` (natural idempotency, safe for offline replays);
 *  - stored MAC differs, or the MAC is already on another device -> 409 `DEVICE_MAC_MISMATCH`,
 *    `DEVICE_MAC_MISMATCH` audit and `alert.device_mac_mismatch` for back office.
 */
@Injectable()
export class MobileDeviceService {
  private readonly logger = new Logger(MobileDeviceService.name);

  constructor(
    private readonly mobile: MobileRepository,
    private readonly devices: MobileDeviceRepository,
    private readonly audit: AuditRepository,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
  ) {}

  async reportMac(actor: ContextUser, dto: ReportDeviceMacDto): Promise<DeviceMacResult> {
    const driver = await this.mobile.findDriver(actor.id);
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId: actor.id });
    if (!driver.assignedVehicleId) {
      throw new AppException(ERROR_CODES.NO_ASSIGNED_VEHICLE, 'Select a vehicle before reporting its ELD.', 409);
    }

    // The payload's deviceId is untrusted: it must be THE device bound to the selected unit.
    const device = await this.devices.findDevice(dto.deviceId);
    if (!device || device.vehicleId !== driver.assignedVehicleId) {
      throw new AppException(
        ERROR_CODES.DEVICE_NOT_FOUND,
        'Device not found, or it is not the ELD bound to your selected vehicle.',
        404,
        { deviceId: dto.deviceId },
      );
    }

    const reported = dto.macAddress;
    let stored = device.bleMacAddress;
    if (isEmpty(stored)) {
      try {
        const changed = await this.devices.fillEmptyMac(device.id, reported);
        if (changed === 1) {
          await this.writeAudit(actor, 'DEVICE_MAC_REPORTED', device.id, {
            before: { bleMacAddress: stored ?? null },
            after: { bleMacAddress: reported, vehicleId: device.vehicleId },
            detail: 'Driver app reported the observed BLE MAC of the unit\'s PT30 (stored MAC was empty).',
          });
          return { deviceId: device.id, macAddress: reported, outcome: 'STORED' };
        }
        // Lost a race with another writer — decide against what is stored now.
        stored = (await this.devices.findDevice(device.id))?.bleMacAddress ?? null;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'P2002') throw err;
        return this.mismatch(actor, device, null, reported, 'MAC_ON_ANOTHER_DEVICE');
      }
    }

    if (sameMac(stored, reported)) {
      return { deviceId: device.id, macAddress: normalizeMac(stored) ?? reported, outcome: 'UNCHANGED' };
    }
    return this.mismatch(actor, device, stored, reported, 'STORED_MAC_DIFFERS');
  }

  private async mismatch(
    actor: ContextUser,
    device: { id: string; serial: string; vehicleId: string | null },
    stored: string | null,
    reported: string,
    reason: 'STORED_MAC_DIFFERS' | 'MAC_ON_ANOTHER_DEVICE',
  ): Promise<never> {
    const payload = {
      deviceId: device.id,
      deviceSerial: device.serial,
      vehicleId: device.vehicleId,
      driverId: actor.id,
      storedMac: stored,
      reportedMac: reported,
      reason,
    };
    await this.writeAudit(actor, 'DEVICE_MAC_MISMATCH', device.id, {
      before: { bleMacAddress: stored },
      after: payload,
      detail: 'Driver app saw a BLE MAC that does not match the device record — not written; back office alerted.',
    });
    await this.raiseAlert('alert.device_mac_mismatch', payload);
    throw new AppException(
      ERROR_CODES.DEVICE_MAC_MISMATCH,
      'The ELD you are connected to does not match the device on record for this vehicle. Back office has been notified.',
      409,
      { deviceId: device.id, reason },
    );
  }

  private async raiseAlert(name: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.publish(name, payload);
    try {
      await this.alertQueue.add(name, payload);
    } catch (err) {
      this.logger.error({ err, alert: name }, 'Failed to enqueue alert');
    }
  }

  private async writeAudit(
    actor: ContextUser,
    action: string,
    objectId: string,
    data: { before: Record<string, unknown>; after: Record<string, unknown>; detail: string },
  ): Promise<void> {
    const ctx = RequestContext.get();
    try {
      await this.audit.insert({
        actorId: actor.id,
        actorType: EditorType.DRIVER,
        action,
        objectType: 'Device',
        objectId,
        before: data.before as Prisma.InputJsonValue,
        after: data.after as Prisma.InputJsonValue,
        detail: data.detail,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, action, objectId }, 'Failed to write the device MAC audit entry');
    }
  }
}

function isEmpty(mac: string | null | undefined): boolean {
  return mac === null || mac === undefined || mac.trim() === '';
}

/** Back office may have typed the MAC in any spelling; compare canonical forms (raw fallback). */
function sameMac(stored: string | null, reported: string): boolean {
  if (isEmpty(stored)) return false;
  const canonical = normalizeMac(stored) ?? stored!.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return canonical === reported || canonical === reported.replace(/:/g, '');
}
