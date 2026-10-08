import { Injectable } from '@nestjs/common';
import type { Device } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

/** MG-BLE-1/2 — the only device write a driver can cause: filling an EMPTY `bleMacAddress`. */
@Injectable()
export class MobileDeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  findDevice(id: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { id } });
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
