import { Injectable } from '@nestjs/common';
import type { Device, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface DeviceListFilter {
  status?: Device['status'];
  bleState?: Device['bleState'];
  vehicleId?: string;
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
      ...(filter.status && { status: filter.status }),
      ...(filter.bleState && { bleState: filter.bleState }),
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.q && {
        OR: [
          { serial: { contains: filter.q, mode: 'insensitive' } },
          { bleMacAddress: { contains: filter.q, mode: 'insensitive' } },
          { firmware: { contains: filter.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.device.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.device.count({ where }),
    ]);
    return { items, total };
  }

  listAll(): Promise<Device[]> {
    return this.prisma.device.findMany({ orderBy: { serial: 'asc' } });
  }
}
