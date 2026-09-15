import { Injectable } from '@nestjs/common';
import type { Prisma, Vehicle } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface VehicleListFilter {
  status?: Vehicle['status'];
  q?: string;
}

export interface VehicleListPage {
  items: Vehicle[];
  total: number;
}

@Injectable()
export class VehiclesRepository extends BaseRepository<
  Vehicle,
  Prisma.VehicleWhereInput,
  Prisma.VehicleWhereUniqueInput,
  Prisma.VehicleCreateInput,
  Prisma.VehicleUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Vehicle,
    Prisma.VehicleWhereInput,
    Prisma.VehicleWhereUniqueInput,
    Prisma.VehicleCreateInput,
    Prisma.VehicleUpdateInput
  > {
    return this.prisma.vehicle;
  }

  findByUnitNumber(unitNumber: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findUnique({ where: { unitNumber } });
  }

  findByVin(vin: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findUnique({ where: { vin } });
  }

  async list(
    filter: VehicleListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<VehicleListPage> {
    const where: Prisma.VehicleWhereInput = {
      ...(filter.status && { status: filter.status }),
      ...(filter.q && {
        OR: [
          { unitNumber: { contains: filter.q, mode: 'insensitive' } },
          { vin: { contains: filter.q, mode: 'insensitive' } },
          { make: { contains: filter.q, mode: 'insensitive' } },
          { model: { contains: filter.q, mode: 'insensitive' } },
          { licensePlate: { contains: filter.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.vehicle.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.vehicle.count({ where }),
    ]);
    return { items, total };
  }

  listAll(): Promise<Vehicle[]> {
    return this.prisma.vehicle.findMany({ orderBy: { unitNumber: 'asc' } });
  }

  /**
   * TZ §5.10 hard rule support — ids of OPEN + CRITICAL defects on this unit. Queried directly
   * against the `Defect` table (not via `DefectsRepository`) to avoid a `VehiclesModule <->
   * ServiceModule` import cycle; `VehiclesModule` stays the leaf the same way it already is for
   * `DriversModule`.
   */
  findOpenCriticalDefectIds(vehicleId: string): Promise<Array<{ id: string }>> {
    return this.prisma.defect.findMany({
      where: { vehicleId, status: 'OPEN', severity: 'CRITICAL' },
      select: { id: true },
    });
  }
}
