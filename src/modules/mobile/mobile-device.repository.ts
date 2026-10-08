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
}
