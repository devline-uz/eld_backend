import { Injectable, Logger } from '@nestjs/common';
import type { Defect } from '@prisma/client';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { EventBusService } from '../../core/events/event-bus.service';
import { holdsVehicleOutOfService, outOfServiceHoldingDefectsWhere } from '../vehicles/lib/out-of-service-defects';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { assertDefectLinkable, assertWorkOrderEditable, resolveCompletedAt } from './defect-rules';
import { DefectsRepository } from './defects.repository';
import { AssignDefectDto, DefectListQueryDto, LinkDefectWorkOrderDto, ResolveDefectDto } from './dto/service.dto';
import { WorkOrdersRepository } from './work-orders.repository';

const SORTABLE_FIELDS = ['createdAt', 'severity', 'status'] as const;

/**
 * TZ §5.10 out-of-service rule: `severity = CRITICAL` + `status = OPEN` flips
 * `Vehicle.status = OUT_OF_SERVICE` (already enforced on submission by `MobileDvirService`,
 * Phase 6). This service owns the OTHER half — resolving the last open CRITICAL defect on a
 * vehicle restores it automatically. "Resolving" means REPAIRED / NOT_REQUIRED — a `DEFERRED`
 * critical defect still holds the unit out of service (QA CODE-008, see
 * `vehicles/lib/out-of-service-defects.ts`). The restore never happens for a vehicle that isn't
 * currently `OUT_OF_SERVICE` (e.g. an admin already put it back manually, or it was
 * `INACTIVE` for an unrelated reason) — only the automatic path is idempotent here.
 */
@Injectable()
export class DefectsService {
  private readonly logger = new Logger(DefectsService.name);

  constructor(
    private readonly repo: DefectsRepository,
    private readonly vehicles: VehiclesRepository,
    private readonly events: EventBusService,
    private readonly workOrders: WorkOrdersRepository,
  ) {}

  async list(query: DefectListQueryDto): Promise<OffsetPage<Defect>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { createdAt: 'desc' });
    const { items, total } = await this.repo.list(
      { vehicleId: query.vehicleId, status: query.status, severity: query.severity, outOfService: query.outOfService, assigneeId: query.assigneeId },
      query.page,
      query.limit,
      orderBy,
    );
    return toOffsetPage(items, total, query.page, query.limit);
  }

  async get(id: string): Promise<Defect> {
    return this.getOrThrow(id);
  }

  private async getOrThrow(id: string): Promise<Defect> {
    const defect = await this.repo.findById({ id });
    if (!defect) throw new AppException(ERROR_CODES.DEFECT_NOT_FOUND, 'Defect not found.', 404, { id });
    return defect;
  }

  /**
   * §20 B-68 — `resolutionType` (`REPAIRED` / `NOT_REQUIRED` / `DEFERRED`) is the field the
   * §396.11 record actually reads for display; `Defect.status` only tracks OPEN-ness for the
   * out-of-service rule and never carries `NOT_REQUIRED` (no such status exists — see the
   * schema comment on `DefectResolutionType`). A `NOT_REQUIRED` resolution must never be
   * rendered as a repair.
   * §20 B-70 — `correctedBy`/`completedAt`/`laborHours`/`partsCostUsd` complete the repair record.
   */
  async resolve(id: string, dto: ResolveDefectDto, resolvedById: string): Promise<Defect> {
    const defect = await this.getOrThrow(id);
    // QA CODE-034 — a repaired / not-required defect stays resolved; the time is validated.
    const completedAt = resolveCompletedAt(defect, dto.completedAt, new Date());
    const status = dto.resolutionType === 'DEFERRED' ? 'DEFERRED' : 'REPAIRED';
    // CODE-077 — a changed work-order link is checked BEFORE anything is written and applied in
    // the same update as the resolution: either both land or neither does.
    const relink = dto.workOrderId !== undefined && dto.workOrderId !== defect.workOrderId;
    if (relink) await this.assertLink(defect, dto.workOrderId ?? null);
    const updated = await this.repo.update(
      { id },
      {
        ...(relink && { workOrder: dto.workOrderId ? { connect: { id: dto.workOrderId } } : { disconnect: true } }),
        status,
        resolutionType: dto.resolutionType,
        resolvedAt: new Date(),
        resolvedById,
        resolutionNote: dto.resolutionNote ?? null,
        correctedBy: dto.correctedBy ?? null,
        completedAt,
        laborHours: dto.laborHours ?? null,
        partsCostUsd: dto.partsCostUsd ?? null,
      },
    );

    // QA CODE-008 — deferring a critical defect postpones the repair; it must never put an
    // out-of-service unit back to ACTIVE. Only an actual repair / "no repair needed" of a defect
    // that was holding the unit (OPEN, IN_PROGRESS or previously DEFERRED) can release it.
    if (status !== 'DEFERRED' && holdsVehicleOutOfService(defect)) {
      await this.maybeRestoreVehicle(defect.vehicleId);
    }

    await this.events.publish('defect.resolved', { defectId: id, vehicleId: defect.vehicleId, resolutionType: dto.resolutionType });
    return updated;
  }

  /** QA CODE-032 — the target must exist (404, not a Prisma 500), be open and on the same unit,
   * and a defect is never moved off a work order that is already signed off. */
  async linkWorkOrder(id: string, dto: LinkDefectWorkOrderDto): Promise<Defect> {
    const defect = await this.getOrThrow(id);
    await this.assertLink(defect, dto.workOrderId);
    return this.repo.update({ id }, { workOrder: dto.workOrderId ? { connect: { id: dto.workOrderId } } : { disconnect: true } });
  }

  /** QA CODE-032 — the link rules shared by `linkWorkOrder` and `resolve` (CODE-077). */
  private async assertLink(defect: Defect, workOrderId: string | null): Promise<void> {
    if (defect.workOrderId && defect.workOrderId !== workOrderId) {
      const current = await this.workOrders.findById({ id: defect.workOrderId });
      if (current) assertWorkOrderEditable(current);
    }
    if (workOrderId) {
      const workOrder = await this.workOrders.findById({ id: workOrderId });
      if (!workOrder) {
        throw new AppException(ERROR_CODES.WORK_ORDER_NOT_FOUND, 'Work order not found.', 404, { workOrderId });
      }
      assertDefectLinkable(defect, workOrder);
    }
  }

  /** §20 B-40 — defect assignee/shop (`null` clears it). CODE-076 — the assignee must be an
   * active user; any uuid used to be stored (and rendered as "Unassigned"). */
  async assign(id: string, dto: AssignDefectDto): Promise<Defect> {
    await this.getOrThrow(id);
    if (dto.assigneeId && !(await this.repo.activeUserExists(dto.assigneeId))) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'The assignee must be an active user.', 422, {
        assigneeId: 'Pick an active user.',
      });
    }
    return this.repo.update({ id }, { assigneeId: dto.assigneeId });
  }

  /** Restores `Vehicle.status` to `ACTIVE` once no open / in-progress / deferred CRITICAL defect
   * remains — only if the vehicle is currently `OUT_OF_SERVICE` (never overrides an unrelated
   * manual state). */
  private async maybeRestoreVehicle(vehicleId: string): Promise<void> {
    // The defect just resolved is now `REPAIRED`, so this count already excludes it.
    const remaining = await this.repo.count(outOfServiceHoldingDefectsWhere(vehicleId));
    if (remaining > 0) return;
    // An open work order flagged `Keep the unit out of service` still holds the unit.
    if ((await this.repo.countOutOfServiceWorkOrders(vehicleId)) > 0) return;
    const vehicle = await this.vehicles.findById({ id: vehicleId });
    if (!vehicle || vehicle.status !== 'OUT_OF_SERVICE') return;
    await this.vehicles.update({ id: vehicleId }, { status: 'ACTIVE' });
    this.logger.log({ vehicleId }, 'Vehicle restored from OUT_OF_SERVICE — last open CRITICAL defect resolved');
    await this.events.publish('vehicle.restored_from_out_of_service', { vehicleId });
  }
}
