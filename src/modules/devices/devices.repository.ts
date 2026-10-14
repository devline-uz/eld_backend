import { Injectable } from '@nestjs/common';
import type { Device, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { containsInsensitive } from '../../common/text/insensitive';

export interface DeviceListFilter {
  status?: Device['status'];
  bleState?: Device['bleState'];
  vehicleId?: string;
  /** pt30_pt40/tz.md §9.3 — `Device.isVirtual` filter. */
  isVirtual?: boolean;
  q?: string;
}

export interface DeviceListPage {
  items: Device[];
  total: number;
}

@Injectable()
export class DevicesRepository extends BaseRepository<
  Device,
  Prisma.DeviceWhereInput,
  Prisma.DeviceWhereUniqueInput,
  Prisma.DeviceCreateInput,
  Prisma.DeviceUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Device,
    Prisma.DeviceWhereInput,
    Prisma.DeviceWhereUniqueInput,
    Prisma.DeviceCreateInput,
    Prisma.DeviceUpdateInput
  > {
    return this.prisma.device;
  }

  findBySerial(serial: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { serial } });
  }

  findByVehicleId(vehicleId: string): Promise<Device | null> {
    return this.prisma.device.findUnique({ where: { vehicleId } });
  }

  async list(
    filter: DeviceListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<DeviceListPage> {
    const where: Prisma.DeviceWhereInput = {
      // A retired device has left the inventory ("Retiring this device removes it from the device
      // inventory") — it is listed only when asked for explicitly with `?status=RETIRED`.
      status: filter.status ?? { not: 'RETIRED' },
      ...(filter.bleState && { bleState: filter.bleState }),
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.isVirtual !== undefined && { isVirtual: filter.isVirtual }),
      ...(filter.q && {
        OR: [
          { serial: containsInsensitive(filter.q) },
          { bleMacAddress: containsInsensitive(filter.q) },
          { firmware: containsInsensitive(filter.q) },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.device.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.device.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * UI-012 — fleet-wide connection counts over the inventory (RETIRED excluded, list filters
   * ignored). `connected` is the effective state: stored CONNECTED AND heard from since
   * `connectedSince`; `offlineOver24h` = never seen or silent since before `offlineBefore`.
   */
  async connectionCounts(connectedSince: Date, offlineBefore: Date): Promise<{ total: number; connected: number; offlineOver24h: number }> {
    const inventory: Prisma.DeviceWhereInput = { status: { not: 'RETIRED' } };
    const [total, connected, offlineOver24h] = await Promise.all([
      this.prisma.device.count({ where: inventory }),
      this.prisma.device.count({ where: { ...inventory, bleState: 'CONNECTED', lastSeenAt: { gte: connectedSince } } }),
      this.prisma.device.count({ where: { ...inventory, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: offlineBefore } }] } }),
    ]);
    return { total, connected, offlineOver24h };
  }

  listAll(): Promise<Device[]> {
    return this.prisma.device.findMany({ orderBy: { serial: 'asc' } });
  }
}
