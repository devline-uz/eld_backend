import { Injectable, Logger } from '@nestjs/common';
import { EditorType, type Device, type Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { AuditRepository } from '../audit/audit.repository';
import { isVirtualDevice, VirtualEldPolicy } from '../carrier/virtual-eld.policy';
import { DeviceView, toDeviceView } from '../devices/devices.service';
import type { RegisterVirtualDeviceDto } from './dto/mobile-device.dto';
import { MobileDeviceRepository } from './mobile-device.repository';
import { MobileRepository } from './mobile.repository';

/**
 * pt30_pt40/tz.md §9.3 / §8.3 — `POST /mobile/virtual-devices`. The driver app found a PT Emulator
 * (`VPT30_…`) over BLE; this creates the `Device` (`isVirtual=true`) if it does not exist and pairs
 * it to the driver's CURRENT unit (`Driver.assignedVehicleId`). Idempotent: the same call again
 * changes nothing and returns the same device.
 *
 * Pairing rules (D-144): the emulator follows the phone — if it is paired elsewhere it moves to
 * the current unit; another VIRTUAL device on that unit is released; a REAL PT30/PT40 on that unit
 * is never displaced (409 `DEVICE_ALREADY_PAIRED`).
 */
@Injectable()
export class MobileVirtualDeviceService {
  private readonly logger = new Logger(MobileVirtualDeviceService.name);

  constructor(
    private readonly mobile: MobileRepository,
    private readonly devices: MobileDeviceRepository,
    private readonly virtualEld: VirtualEldPolicy,
    private readonly audit: AuditRepository,
  ) {}

  async register(actor: ContextUser, dto: RegisterVirtualDeviceDto): Promise<DeviceView> {
    await this.virtualEld.assertEnabled({ deviceSerial: dto.serial });

    const driver = await this.mobile.findDriver(actor.id);
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404, { driverId: actor.id });
    const vehicleId = driver.assignedVehicleId;
    if (!vehicleId) {
      throw new AppException(ERROR_CODES.NO_ACTIVE_VEHICLE, 'Select a vehicle before connecting a test (virtual) ELD.', 409);
    }

    try {
      return await this.pair(actor, dto, vehicleId);
    } catch (err) {
      // Two concurrent first calls for the same serial: the loser re-reads and is a no-op.
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      return this.pair(actor, dto, vehicleId);
    }
  }

  private async pair(actor: ContextUser, dto: RegisterVirtualDeviceDto, vehicleId: string): Promise<DeviceView> {
    const [existing, occupant] = await Promise.all([
      this.devices.findBySerial(dto.serial),
      this.devices.findByVehicle(vehicleId),
    ]);

    const releaseId = occupant && occupant.serial !== dto.serial ? occupant.id : null;
    if (occupant && releaseId && !isVirtualDevice(occupant)) {
      throw new AppException(
        ERROR_CODES.DEVICE_ALREADY_PAIRED,
        'This unit already has a real ELD paired — a test (virtual) ELD cannot replace it.',
        409,
        { vehicleId, deviceSerial: occupant.serial },
      );
    }

    const alreadyPaired =
      existing !== null &&
      existing.vehicleId === vehicleId &&
      existing.isVirtual &&
      existing.status === 'ASSIGNED' &&
      existing.model === dto.model &&
      (dto.firmware === undefined || existing.firmware === dto.firmware) &&
      (dto.vin === undefined || existing.reportedVin === dto.vin);
    if (alreadyPaired) return toDeviceView(existing);

    const now = new Date();
    const pairedAt = existing?.vehicleId === vehicleId && existing.pairedAt ? existing.pairedAt : now;
    const create: Prisma.DeviceCreateInput = {
      serial: dto.serial,
      model: dto.model,
      isVirtual: true,
      firmware: dto.firmware,
      reportedVin: dto.vin,
      status: 'ASSIGNED',
      pairedAt,
      vehicle: { connect: { id: vehicleId } },
    };
    const update: Prisma.DeviceUpdateInput = {
      model: dto.model,
      isVirtual: true,
      ...(dto.firmware !== undefined && { firmware: dto.firmware }),
      ...(dto.vin !== undefined && { reportedVin: dto.vin }),
      status: 'ASSIGNED',
      pairedAt,
      vehicle: { connect: { id: vehicleId } },
    };
    const device = await this.devices.pairVirtual({ releaseId, existingId: existing?.id ?? null, create, update });

    await this.writeAudit(actor, existing ? 'DEVICE_VIRTUAL_PAIRED' : 'DEVICE_VIRTUAL_REGISTERED', device, existing, releaseId);
    return toDeviceView(device);
  }

  private async writeAudit(
    actor: ContextUser,
    action: string,
    device: Device,
    before: Device | null,
    releasedDeviceId: string | null,
  ): Promise<void> {
    const ctx = RequestContext.get();
    try {
      await this.audit.insert({
        actorId: actor.id,
        actorType: EditorType.DRIVER,
        action,
        objectType: 'Device',
        objectId: device.id,
        before: before ? { vehicleId: before.vehicleId, status: before.status, model: before.model } : undefined,
        after: { serial: device.serial, isVirtual: true, vehicleId: device.vehicleId, status: device.status, model: device.model, releasedDeviceId },
        detail: 'Driver app paired a PT Emulator (Virtual ELD) to the current unit (pt30_pt40/tz.md §9.3).',
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, action, deviceId: device.id }, 'Failed to write the virtual device audit entry');
    }
  }
}
