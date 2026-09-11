import { Injectable } from '@nestjs/common';
import type { Defect, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface DefectListFilter {
  vehicleId?: string;
  status?: Defect['status'];
  severity?: Defect['severity'];
  outOfService?: boolean;
}

export interface DefectListPage {
  items: Defect[];
  total: number;
}

@Injectable()
export class DefectsRepository extends BaseRepository<
  Defect,
  Prisma.DefectWhereInput,
  Prisma.DefectWhereUniqueInput,
  Prisma.DefectCreateInput,
  Prisma.DefectUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<Defect, Prisma.DefectWhereInput, Prisma.DefectWhereUniqueInput, Prisma.DefectCreateInput, Prisma.DefectUpdateInput> {
    return this.prisma.defect;
  }

  async list(filter: DefectListFilter, page: number, limit: number, orderBy: Record<string, 'asc' | 'desc'>): Promise<DefectListPage> {
    const where: Prisma.DefectWhereInput = {
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.status && { status: filter.status }),
      ...(filter.severity && { severity: filter.severity }),
      ...(filter.outOfService !== undefined && { outOfService: filter.outOfService }),
    };
    const [items, total] = await Promise.all([
      this.prisma.defect.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.defect.count({ where }),
    ]);
    return { items, total };
  }

  findByWorkOrder(workOrderId: string): Promise<Defect[]> {
    return this.prisma.defect.findMany({ where: { workOrderId } });
  }
}
