import { Injectable } from '@nestjs/common';
import type { Device, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { equalsInsensitive } from '../../common/text/insensitive';

/** MG-BLE-1/2 — the only device write a driver can cause: filling an EMPTY `bleMacAddress`. */
@Injectable()
export class MobileDeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  findDevice(id: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { id } });
  }

  /** CODE-009 — the registry stores serials trimmed + upper-cased; exact match first (hot path),
   * then case-insensitive so an app reporting `pt30_a86e` still resolves its device. */
  async findBySerial(serial: string): Promise<Device | null> {
    return (
      (await this.prisma.device.findUnique({ where: { serial } })) ??
      (await this.prisma.device.findFirst({ where: { serial: equalsInsensitive(serial.trim()) } }))
    );
  }

  findByVehicle(vehicleId: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { vehicleId } });
  }

  /**
   * pt30_pt40/tz.md §9.3 — pair a PT Emulator to `vehicleId` in one transaction: release the
   * virtual device currently on that unit (if any, `releaseId`), then create or update the row.
   */
  pairVirtual(args: {
    releaseId: string | null;
    existingId: string | null;
    create: Prisma.DeviceCreateInput;
    update: Prisma.DeviceUpdateInput;
  }): Promise<Device> {
    return this.prisma.$transaction(async (tx) => {
      if (args.releaseId) {
        await tx.device.update({
          where: { id: args.releaseId },
          data: { vehicle: { disconnect: true }, status: 'UNASSIGNED', pairedAt: null },
        });
      }
      return args.existingId
        ? tx.device.update({ where: { id: args.existingId }, data: args.update })
        : tx.device.create({ data: args.create });
    });
  }

  /** Compare-and-set: writes only while the stored MAC is still empty; returns rows changed (0/1). */
  async fillEmptyMac(id: string, mac: string): Promise<number> {
    const result = await this.prisma.device.updateMany({
      where: { id, OR: [{ bleMacAddress: null }, { bleMacAddress: '' }] },
      data: { bleMacAddress: mac },
    });
    return result.count;
  }

  /**
   * B-151 — has THIS driver already raised a MAC mismatch on this device since `since`? One
   * `(objectType, objectId)`-indexed lookup; used to stop a looping app (or a hostile token) from
   * turning every retry into an audit row + back-office alert.
   */
  async hasRecentMismatch(deviceId: string, driverId: string, since: Date): Promise<boolean> {
    const row = await this.prisma.auditLog.findFirst({
      where: { objectType: 'Device', objectId: deviceId, action: 'DEVICE_MAC_MISMATCH', actorId: driverId, createdAt: { gte: since } },
      select: { id: true },
    });
    return row !== null;
  }
}
