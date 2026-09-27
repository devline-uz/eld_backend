import { Injectable } from '@nestjs/common';
import type { Prisma, WorkOrder } from '@prisma/client';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { EventBusService } from '../../core/events/event-bus.service';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { DefectsRepository } from './defects.repository';
import { CreateWorkOrderDto, UpdateWorkOrderDto, WorkOrderListQueryDto } from './dto/service.dto';
import { WorkOrdersRepository } from './work-orders.repository';

const SORTABLE_FIELDS = ['openedAt', 'dueAt', 'status', 'priority', 'number'] as const;
const CLOSED_STATUSES = new Set<WorkOrder['status']>(['DONE', 'CANCELLED']);

/** TZ §5.10 "Create work order" screen — a defect resolution workflow tied to a work order:
 * a defect can be attached to a work order while OPEN, and closing the work order requires
 * every attached defect to already carry a resolution (REPAIRED/DEFERRED). */
@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly repo: WorkOrdersRepository,
    private readonly defects: DefectsRepository,
    private readonly vehicles: VehiclesRepository,
    private readonly events: EventBusService,
  ) {}

  async list(query: WorkOrderListQueryDto): Promise<OffsetPage<WorkOrder>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { openedAt: 'desc' });
    const { items, total } = await this.repo.list(
      { vehicleId: query.vehicleId, status: query.status, priority: query.priority, q: query.q },
      query.page,
      query.limit,
      orderBy,
    );
    return toOffsetPage(items, total, query.page, query.limit);
  }

  async get(id: string): Promise<WorkOrder> {
    return this.getOrThrow(id);
  }

  private async getOrThrow(id: string): Promise<WorkOrder> {
    const workOrder = await this.repo.findById({ id });
    if (!workOrder) throw new AppException(ERROR_CODES.WORK_ORDER_NOT_FOUND, 'Work order not found.', 404, { id });
    return workOrder;
  }

  async create(dto: CreateWorkOrderDto, openedById: string): Promise<WorkOrder> {
    const vehicle = await this.vehicles.findById({ id: dto.vehicleId });
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId: dto.vehicleId });

    const number = await this.repo.nextNumber();
    const workOrder = await this.repo.create({
      number,
      vehicle: { connect: { id: dto.vehicleId } },
      title: dto.title,
      description: dto.description ?? null,
      priority: dto.priority,
      vendor: dto.vendor ?? null,
      costUsd: dto.costUsd ?? null,
      odometerMi: dto.odometerMi ?? null,
      openedById,
      dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
      estimatedLaborHours: dto.estimatedLaborHours ?? null,
      keepOutOfService: dto.keepOutOfService,
      notifyDriver: dto.notifyDriver,
      blockDispatchAssignment: dto.blockDispatchAssignment,
    });

    if (dto.defectIds?.length) {
      await Promise.all(dto.defectIds.map((defectId) => this.attachDefect(workOrder.id, defectId)));
    }

    await this.events.publish('work_order.created', { workOrderId: workOrder.id, vehicleId: dto.vehicleId, defectCount: dto.defectIds?.length ?? 0 });
    return workOrder;
  }

  async update(id: string, dto: UpdateWorkOrderDto): Promise<WorkOrder> {
    const workOrder = await this.getOrThrow(id);
    this.assertOpen(workOrder);
    const data: Prisma.WorkOrderUpdateInput = {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.priority !== undefined && { priority: dto.priority }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.vendor !== undefined && { vendor: dto.vendor }),
      ...(dto.costUsd !== undefined && { costUsd: dto.costUsd }),
      ...(dto.odometerMi !== undefined && { odometerMi: dto.odometerMi }),
      ...(dto.dueAt !== undefined && { dueAt: dto.dueAt ? new Date(dto.dueAt) : null }),
      ...(dto.estimatedLaborHours !== undefined && { estimatedLaborHours: dto.estimatedLaborHours }),
      ...(dto.keepOutOfService !== undefined && { keepOutOfService: dto.keepOutOfService }),
      ...(dto.notifyDriver !== undefined && { notifyDriver: dto.notifyDriver }),
      ...(dto.blockDispatchAssignment !== undefined && { blockDispatchAssignment: dto.blockDispatchAssignment }),
    };
    return this.repo.update({ id }, data);
  }

  async attachDefect(id: string, defectId: string): Promise<WorkOrder> {
    const workOrder = await this.getOrThrow(id);
    this.assertOpen(workOrder);
    const defect = await this.defects.findById({ id: defectId });
    if (!defect) throw new AppException(ERROR_CODES.DEFECT_NOT_FOUND, 'Defect not found.', 404, { defectId });
    await this.defects.update({ id: defectId }, { workOrder: { connect: { id } } });
    return workOrder;
  }

  /** Closing requires every attached defect to already have a resolution — the work order is
   * where the fleet manager confirms the repair actually happened before signing it off. */
  async close(id: string): Promise<WorkOrder> {
    const workOrder = await this.getOrThrow(id);
    this.assertOpen(workOrder);
    const attached = await this.defects.findByWorkOrder(id);
    const unresolved = attached.filter((d) => d.status === 'OPEN' || d.status === 'IN_PROGRESS');
    if (unresolved.length) {
      throw new AppException(ERROR_CODES.DEFECT_NOT_RESOLVED, 'One or more attached defects are not resolved yet.', 409, {
        unresolvedDefectIds: unresolved.map((d) => d.id),
      });
    }
    const closed = await this.repo.update({ id }, { status: 'DONE', closedAt: new Date() });
    await this.events.publish('work_order.closed', { workOrderId: id, vehicleId: workOrder.vehicleId });
    return closed;
  }

  async cancel(id: string): Promise<WorkOrder> {
    const workOrder = await this.getOrThrow(id);
    this.assertOpen(workOrder);
    return this.repo.update({ id }, { status: 'CANCELLED', closedAt: new Date() });
  }

  private assertOpen(workOrder: WorkOrder): void {
    if (CLOSED_STATUSES.has(workOrder.status)) {
      throw new AppException(ERROR_CODES.WORK_ORDER_CLOSED, 'Work order is already closed or cancelled.', 409, { workOrderId: workOrder.id });
    }
  }
}
