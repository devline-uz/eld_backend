import { Injectable } from '@nestjs/common';
import type { Prisma, WorkOrder } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface WorkOrderListFilter {
  vehicleId?: string;
  status?: WorkOrder['status'];
  priority?: WorkOrder['priority'];
  q?: string;
}

export interface WorkOrderListPage {
  items: WorkOrder[];
  total: number;
}

@Injectable()
export class WorkOrdersRepository extends BaseRepository<
  WorkOrder,
  Prisma.WorkOrderWhereInput,
  Prisma.WorkOrderWhereUniqueInput,
  Prisma.WorkOrderCreateInput,
  Prisma.WorkOrderUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    WorkOrder,
    Prisma.WorkOrderWhereInput,
    Prisma.WorkOrderWhereUniqueInput,
    Prisma.WorkOrderCreateInput,
    Prisma.WorkOrderUpdateInput
  > {
    return this.prisma.workOrder;
  }

  async list(filter: WorkOrderListFilter, page: number, limit: number, orderBy: Record<string, 'asc' | 'desc'>): Promise<WorkOrderListPage> {
    const where: Prisma.WorkOrderWhereInput = {
      ...(filter.vehicleId && { vehicleId: filter.vehicleId }),
      ...(filter.status && { status: filter.status }),
      ...(filter.priority && { priority: filter.priority }),
      ...(filter.q && { OR: [{ number: { contains: filter.q, mode: 'insensitive' } }, { title: { contains: filter.q, mode: 'insensitive' } }] }),
    };
    const [items, total] = await Promise.all([
      this.prisma.workOrder.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.workOrder.count({ where }),
    ]);
    return { items, total };
  }

  /** `WO-2214`-style sequential number (TZ §5.10 example). Race-safe enough for this volume:
   * a collision retries once inside a unique-constraint catch at the service layer. */
  async nextNumber(): Promise<string> {
    const last = await this.prisma.workOrder.findFirst({ orderBy: { openedAt: 'desc' }, select: { number: true } });
    const lastSeq = last?.number ? Number(last.number.replace(/\D/g, '')) || 0 : 0;
    return `WO-${(lastSeq + 1).toString().padStart(4, '0')}`;
  }
}
