import { Injectable } from '@nestjs/common';
import type { Dvir, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface DvirListFilter {
  vehicleId?: string;
  driverId?: string;
  repairStatus?: Dvir['repairStatus'];
}

export interface DvirListPage {
  items: Dvir[];
  total: number;
}

/** TZ §5.10 — web-side read of DVIRs the mobile app submitted, plus the mechanic sign-off
 * step. Driver-side submission is `MobileDvirService` (Phase 6); this is the "DVIR &
 * Maintenance" screen's read/review path. */
@Injectable()
export class DvirAdminRepository extends BaseRepository<
  Dvir,
  Prisma.DvirWhereInput,
  Prisma.DvirWhereUniqueInput,
  Prisma.DvirCreateInput,
  Prisma.DvirUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<Dvir, Prisma.DvirWhereInput, Prisma.DvirWhereUniqueInput, Prisma.DvirCreateInput, Prisma.DvirUpdateInput> {
    return this.prisma.dvir;
  }

  async list(filter: DvirListFilter, page: number, limit: number, orderBy: Record<string, 'asc' | 'desc'>): Promise<DvirListPage> {
    const where: Prisma.DvirWhereInput = {
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.driverId && { driverId: filter.driverId }),
      ...(filter.repairStatus && { repairStatus: filter.repairStatus }),
    };
    const [items, total] = await Promise.all([
      this.prisma.dvir.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.dvir.count({ where }),
    ]);
    return { items, total };
  }

  findWithDefects(id: string) {
    return this.prisma.dvir.findUnique({
      where: { id },
      include: { defects: { include: { photos: true } }, photos: true },
    });
  }
}
