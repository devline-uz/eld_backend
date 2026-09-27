import { Injectable } from '@nestjs/common';
import type { Prisma, VehicleStatus, WorkOrder } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface WorkOrderListFilter {
  vehicleId?: string;
  status?: WorkOrder['status'];
  priority?: WorkOrder['priority'];
  q?: string;
}

/** Work orders still in progress — the only ones that can hold a unit out of service. */
export const OPEN_WORK_ORDER_STATUSES: WorkOrder['status'][] = ['OPEN', 'IN_PROGRESS'];

/** Whether a work order in this state keeps its unit out of service. */
export function holdsUnitOutOfService(workOrder: Pick<WorkOrder, 'status' | 'keepOutOfService'>): boolean {
  return workOrder.keepOutOfService && OPEN_WORK_ORDER_STATUSES.includes(workOrder.status);
}

/**
 * `Keep the unit out of service` (web QA fix). Re-derives the unit's status after a work-order write,
 * inside the same transaction:
 *  • an open work order with the flag holds the unit `OUT_OF_SERVICE`;
 *  • when this write `released` a hold (completed / cancelled / flag turned off) and no other open
 *    flagged work order and no open out-of-service DVIR defect remains, the unit goes back to `ACTIVE`.
 * An `INACTIVE` unit is never touched, and a unit put out of service for another reason is only
 * restored when a work-order hold is actually released. Returns the new status, or `null` if unchanged.
 */
export async function syncVehicleOutOfService(
  tx: Prisma.TransactionClient,
  vehicleId: string,
  released: boolean,
): Promise<VehicleStatus | null> {
  const vehicle = await tx.vehicle.findUnique({ where: { id: vehicleId }, select: { status: true } });
  if (!vehicle || vehicle.status === 'INACTIVE') return null;
  const holds = await tx.workOrder.count({
    where: { vehicleId, keepOutOfService: true, status: { in: OPEN_WORK_ORDER_STATUSES } },
  });
  if (holds > 0) {
    if (vehicle.status === 'OUT_OF_SERVICE') return null;
    await tx.vehicle.update({ where: { id: vehicleId }, data: { status: 'OUT_OF_SERVICE' } });
    return 'OUT_OF_SERVICE';
  }
  if (!released || vehicle.status !== 'OUT_OF_SERVICE') return null;
  const outOfServiceDefects = await tx.defect.count({
    where: { vehicleId, outOfService: true, status: { in: ['OPEN', 'IN_PROGRESS'] } },
  });
  if (outOfServiceDefects > 0) return null;
  await tx.vehicle.update({ where: { id: vehicleId }, data: { status: 'ACTIVE' } });
  return 'ACTIVE';
}

export interface SyncedWorkOrder {
  workOrder: WorkOrder;
  vehicleStatus: VehicleStatus | null;
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

  /** Creates a work order and applies its out-of-service hold in one transaction. */
  createSynced(data: Prisma.WorkOrderCreateInput, vehicleId: string): Promise<SyncedWorkOrder> {
    return this.prisma.$transaction(async (tx) => {
      const workOrder = await tx.workOrder.create({ data });
      const vehicleStatus = await syncVehicleOutOfService(tx, vehicleId, false);
      return { workOrder, vehicleStatus };
    });
  }

  /** Updates a work order (edit / complete / cancel) and re-derives its unit's status in one
   * transaction. `before` is the row as read prior to the write — it tells whether a hold was released. */
  updateSynced(before: WorkOrder, data: Prisma.WorkOrderUpdateInput): Promise<SyncedWorkOrder> {
    return this.prisma.$transaction(async (tx) => {
      const workOrder = await tx.workOrder.update({ where: { id: before.id }, data });
      const released = holdsUnitOutOfService(before) && !holdsUnitOutOfService(workOrder);
      const vehicleStatus = await syncVehicleOutOfService(tx, before.vehicleId, released);
      return { workOrder, vehicleStatus };
    });
  }

  /** `WO-2214`-style sequential number (TZ §5.10 example). Race-safe enough for this volume:
   * a collision retries once inside a unique-constraint catch at the service layer. */
  async nextNumber(): Promise<string> {
    const last = await this.prisma.workOrder.findFirst({ orderBy: { openedAt: 'desc' }, select: { number: true } });
    const lastSeq = last?.number ? Number(last.number.replace(/\D/g, '')) || 0 : 0;
    return `WO-${(lastSeq + 1).toString().padStart(4, '0')}`;
  }
}
