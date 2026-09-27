import { Injectable } from '@nestjs/common';
import type { Device, Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import {
  CreateDeviceDto,
  DeviceListQueryDto,
  ImportDevicesDto,
  PairDeviceDto,
  UpdateBleStatusDto,
  UpdateDeviceDto,
  UpdateFirmwareDto,
} from './dto/devices.dto';
import { DevicesRepository } from './devices.repository';
import { deriveDeviceDiagnostics, DeviceDiagnostics } from './diagnostics.util';
import { isFirmwareOutdated } from './firmware.util';

const SORTABLE_FIELDS = ['serial', 'model', 'status', 'bleState', 'lastSeenAt', 'createdAt'] as const;

export type DeviceView = Device & { firmwareOutdated: boolean };

export interface ImportSummary {
  imported: number;
  updated: number;
  failed: Array<{ index: number; error: string }>;
}

function toView(device: Device): DeviceView {
  return { ...device, firmwareOutdated: isFirmwareOutdated(device.firmware) };
}

/** TZ §5.4 — PT30/PT40 registry, pairing, firmware, and BLE status. */
@Injectable()
export class DevicesService {
  constructor(
    private readonly devices: DevicesRepository,
    private readonly vehicles: VehiclesRepository,
  ) {}

  async list(query: DeviceListQueryDto): Promise<OffsetPage<DeviceView>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { serial: 'asc' });
    const { items, total } = await this.devices.list(
      { status: query.status, bleState: query.bleState, vehicleId: query.vehicleId, q: query.q },
      query.page,
      query.limit,
      orderBy,
    );
    return toOffsetPage(items.map(toView), total, query.page, query.limit);
  }

  async get(id: string): Promise<DeviceView> {
    return toView(await this.getRaw(id));
  }

  private async getRaw(id: string): Promise<Device> {
    const device = await this.devices.findById({ id });
    if (!device) throw new AppException(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found.', 404);
    return device;
  }

  async create(dto: CreateDeviceDto): Promise<DeviceView> {
    const existing = await this.devices.findBySerial(dto.serial);
    if (existing) throw AppException.conflict(`Device "${dto.serial}" already registered.`);
    const created = await this.devices.create({
      serial: dto.serial,
      bleMacAddress: dto.bleMacAddress,
      model: dto.model,
      firmware: dto.firmware,
      periodicConnectedSec: dto.periodicConnectedSec,
      periodicDisconnectedMin: dto.periodicDisconnectedMin,
      autoFirmware: dto.autoFirmware,
      shareDiagnostics: dto.shareDiagnostics,
    });
    return toView(created);
  }

  /** §20 B-8 — derived from the latest recorded status/BLE data, never a live device round-trip.
   * An unresponsive device reads `responded: false`; it is never an HTTP error. */
  async diagnostics(id: string): Promise<DeviceDiagnostics> {
    const device = await this.getRaw(id);
    return deriveDeviceDiagnostics(device);
  }

  async update(id: string, dto: UpdateDeviceDto): Promise<DeviceView> {
    await this.getRaw(id);
    const updated = await this.devices.update({ id }, this.toUpdateInput(dto));
    return toView(updated);
  }

  async updateFirmware(id: string, dto: UpdateFirmwareDto): Promise<DeviceView> {
    await this.getRaw(id);
    const updated = await this.devices.update({ id }, { firmware: dto.firmware });
    return toView(updated);
  }

  /** The app reports BLE connectivity; this just records what it says (TZ §5.4). */
  async updateBleStatus(id: string, dto: UpdateBleStatusDto): Promise<DeviceView> {
    await this.getRaw(id);
    const updated = await this.devices.update(
      { id },
      {
        bleState: dto.bleState,
        lastSeenAt: new Date(),
        ...(dto.storedEventsCount !== undefined && { storedEventsCount: dto.storedEventsCount }),
      },
    );
    return toView(updated);
  }

  /** Soft-delete only — see bugs.md B-009 (hard `DELETE` breaks on the `EldEvent` FK's
   * `SET NULL` action under the append-only `REVOKE`) and decisions.md (also correct on its
   * own merits: a device with historical ELD events must never be dropped from the table). */
  async remove(id: string): Promise<DeviceView> {
    await this.getRaw(id);
    const updated = await this.devices.update({ id }, { status: 'RETIRED', vehicle: { disconnect: true }, pairedAt: null });
    return toView(updated);
  }

  /** Hard rule — one device per unit (`@@unique([vehicleId])` in the schema is the backstop). */
  async pair(id: string, dto: PairDeviceDto): Promise<DeviceView> {
    const device = await this.getRaw(id);
    const vehicle = await this.vehicles.findById({ id: dto.vehicleId });
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404);
    const existingForVehicle = await this.devices.findByVehicleId(dto.vehicleId);
    if (existingForVehicle && existingForVehicle.id !== device.id) {
      throw new AppException(ERROR_CODES.DEVICE_ALREADY_PAIRED, 'This unit already has a device paired.', 409);
    }
    const updated = await this.devices.update(
      { id },
      { vehicle: { connect: { id: dto.vehicleId } }, status: 'ASSIGNED', pairedAt: new Date() },
    );
    return toView(updated);
  }

  async unpair(id: string): Promise<DeviceView> {
    await this.getRaw(id);
    const updated = await this.devices.update(
      { id },
      { vehicle: { disconnect: true }, status: 'UNASSIGNED', pairedAt: null },
    );
    return toView(updated);
  }

  async exportAll(): Promise<CreateDeviceDto[]> {
    return (await this.devices.listAll()).map((d) => ({
      serial: d.serial,
      bleMacAddress: d.bleMacAddress ?? undefined,
      model: d.model,
      firmware: d.firmware ?? undefined,
      periodicConnectedSec: d.periodicConnectedSec,
      periodicDisconnectedMin: d.periodicDisconnectedMin,
      autoFirmware: d.autoFirmware,
      shareDiagnostics: d.shareDiagnostics,
    }));
  }

  /** Upserts by `serial` (the device's natural key) so re-importing an export is idempotent. */
  async importMany(dto: ImportDevicesDto): Promise<ImportSummary> {
    const summary: ImportSummary = { imported: 0, updated: 0, failed: [] };
    for (let index = 0; index < dto.devices.length; index += 1) {
      const row = dto.devices[index];
      try {
        const existing = await this.devices.findBySerial(row.serial);
        if (existing) {
          await this.devices.update({ id: existing.id }, this.toUpdateInput(row));
          summary.updated += 1;
        } else {
          await this.devices.create({
            serial: row.serial,
            bleMacAddress: row.bleMacAddress,
            model: row.model,
            firmware: row.firmware,
            periodicConnectedSec: row.periodicConnectedSec,
            periodicDisconnectedMin: row.periodicDisconnectedMin,
          });
          summary.imported += 1;
        }
      } catch (err) {
        summary.failed.push({ index, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    return summary;
  }

  private toUpdateInput(dto: UpdateDeviceDto): Prisma.DeviceUpdateInput {
    return {
      ...(dto.bleMacAddress !== undefined && { bleMacAddress: dto.bleMacAddress }),
      ...(dto.model !== undefined && { model: dto.model }),
      ...(dto.firmware !== undefined && { firmware: dto.firmware }),
      ...(dto.periodicConnectedSec !== undefined && { periodicConnectedSec: dto.periodicConnectedSec }),
      ...(dto.periodicDisconnectedMin !== undefined && { periodicDisconnectedMin: dto.periodicDisconnectedMin }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.autoFirmware !== undefined && { autoFirmware: dto.autoFirmware }),
      ...(dto.shareDiagnostics !== undefined && { shareDiagnostics: dto.shareDiagnostics }),
    };
  }
}
