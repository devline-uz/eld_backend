import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { VehicleStatus, WorkOrder } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { containsInsensitive } from '../../common/text/insensitive';
import { outOfServiceHoldingDefectsWhere } from '../vehicles/lib/out-of-service-defects';

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
 *    flagged work order and no open / in-progress / deferred out-of-service DVIR defect remains, the unit goes back to `ACTIVE`.
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
  // QA CODE-008 — a DEFERRED critical defect still holds the unit (shared definition).
  const outOfServiceDefects = await tx.defect.count({ where: outOfServiceHoldingDefectsWhere(vehicleId) });
  if (outOfServiceDefects > 0) return null;
  await tx.vehicle.update({ where: { id: vehicleId }, data: { status: 'ACTIVE' } });
  return 'ACTIVE';
}

const MAX_NUMBER_ATTEMPTS = 5;

/** P2002 on `WorkOrder.number` — another create took the number between our read and insert. */
function isNumberCollision(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  return Array.isArray(target) ? target.includes('number') : typeof target === 'string' && target.includes('number');
}

/** `WO-2214`-style sequential number: highest existing numeric suffix + 1. The old "latest
 * `openedAt`" read repeated a number when two rows shared an `openedAt` or one was back-dated. */
export async function nextWorkOrderNumber(db: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<string> {
  const rows = await db.$queryRaw<{ seq: bigint | null }[]>`
    SELECT MAX(NULLIF(regexp_replace("number", '[^0-9]', '', 'g'), '')::bigint) AS seq FROM "WorkOrder"`;
  const lastSeq = Number(rows[0]?.seq ?? 0);
  return `WO-${(lastSeq + 1).toString().padStart(4, '0')}`;
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
      ...(filter.q && { OR: [{ number: containsInsensitive(filter.q) }, { title: containsInsensitive(filter.q) }] }),
    };
    const [items, total] = await Promise.all([
      this.prisma.workOrder.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.workOrder.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Creates a work order with its next `WO-####` number, links the given defects and applies its
   * out-of-service hold in one transaction (QA CODE-033). Two concurrent creates can read the same
   * last number; the loser hits `WorkOrder.number @unique` (P2002) and is retried with a fresh one.
   */
  async createSynced(data: Omit<Prisma.WorkOrderCreateInput, 'number'>, vehicleId: string, defectIds: string[] = []): Promise<SyncedWorkOrder> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // B3-08 — serialise numbering: `MAX(number)+1` raced (10 parallel creates exhausted the
          // retries below). The lock is released at commit, so the next create sees this row.
          // `$executeRawUnsafe` — pg_advisory_xact_lock() returns void, which `$queryRaw` cannot map.
          await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, 'work-order-number');
          const number = await nextWorkOrderNumber(tx);
          const workOrder = await tx.workOrder.create({ data: { ...data, number } });
          if (defectIds.length) {
            await tx.defect.updateMany({ where: { id: { in: defectIds } }, data: { workOrderId: workOrder.id } });
          }
          const vehicleStatus = await syncVehicleOutOfService(tx, vehicleId, false);
          return { workOrder, vehicleStatus };
        });
      } catch (err) {
        if (attempt >= MAX_NUMBER_ATTEMPTS || !isNumberCollision(err)) throw err;
      }
    }
  }

  /** Updates a work order (edit / complete / cancel) and re-derives its unit's status in one
   * transaction. `before` is the row as read prior to the write — it tells whether a hold was released. */
  updateSynced(before: WorkOrder, data: Prisma.WorkOrderUpdateInput): Promise<SyncedWorkOrder> {
    return this.prisma.$transaction(async (tx) => {
      // CODE-078 — the write only applies to the row in the status it was read in: an edit that
      // raced a close (or a cancel) no longer reopens a DONE work order. Prisma reports the
      // missed `where` as P2025.
      const workOrder = await tx.workOrder
        .update({ where: { id: before.id, status: before.status }, data })
        .catch((err: unknown) => {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
            throw new AppException(
              ERROR_CODES.WORK_ORDER_CLOSED,
              'This work order was changed by someone else in the meantime. Reload it and try again.',
              409,
              { workOrderId: before.id },
            );
          }
          throw err;
        });
      const released = holdsUnitOutOfService(before) && !holdsUnitOutOfService(workOrder);
      const vehicleStatus = await syncVehicleOutOfService(tx, before.vehicleId, released);
      return { workOrder, vehicleStatus };
    });
  }

  /** Next `WO-2214`-style number (TZ §5.10 example) — see {@link nextWorkOrderNumber}. */
  nextNumber(): Promise<string> {
    return nextWorkOrderNumber(this.prisma);
  }
}
