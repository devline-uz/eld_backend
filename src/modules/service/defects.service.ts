import { Injectable, Logger } from '@nestjs/common';
import type { Defect } from '@prisma/client';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { EventBusService } from '../../core/events/event-bus.service';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { DefectsRepository } from './defects.repository';
import { DefectListQueryDto, LinkDefectWorkOrderDto, ResolveDefectDto } from './dto/service.dto';

const SORTABLE_FIELDS = ['createdAt', 'severity', 'status'] as const;

/**
 * TZ §5.10 out-of-service rule: `severity = CRITICAL` + `status = OPEN` flips
 * `Vehicle.status = OUT_OF_SERVICE` (already enforced on submission by `MobileDvirService`,
 * Phase 6). This service owns the OTHER half — resolving the last open CRITICAL defect on a
 * vehicle restores it automatically. The restore never happens for a vehicle that isn't
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
  ) {}

  async list(query: DefectListQueryDto): Promise<OffsetPage<Defect>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { createdAt: 'desc' });
    const { items, total } = await this.repo.list(
      { vehicleId: query.vehicleId, status: query.status, severity: query.severity, outOfService: query.outOfService },
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

  async resolve(id: string, dto: ResolveDefectDto, resolvedById: string): Promise<Defect> {
    const defect = await this.getOrThrow(id);
    const updated = await this.repo.update(
      { id },
      { status: dto.status, resolvedAt: new Date(), resolvedById, resolutionNote: dto.resolutionNote ?? null },
    );

    if (defect.severity === 'CRITICAL' && defect.status === 'OPEN') {
      await this.maybeRestoreVehicle(defect.vehicleId);
    }

    await this.events.publish('defect.resolved', { defectId: id, vehicleId: defect.vehicleId, status: dto.status });
    return updated;
  }

  async linkWorkOrder(id: string, dto: LinkDefectWorkOrderDto): Promise<Defect> {
    await this.getOrThrow(id);
    return this.repo.update({ id }, { workOrder: dto.workOrderId ? { connect: { id: dto.workOrderId } } : { disconnect: true } });
  }

  /** Restores `Vehicle.status` to `ACTIVE` once no OPEN CRITICAL defect remains — only if the
   * vehicle is currently `OUT_OF_SERVICE` (never overrides an unrelated manual state). */
  private async maybeRestoreVehicle(vehicleId: string): Promise<void> {
    // The defect just resolved is no longer `status: 'OPEN'`, so this count already excludes it.
    const remaining = await this.repo.count({ vehicleId, status: 'OPEN', severity: 'CRITICAL' });
    if (remaining > 0) return;
    const vehicle = await this.vehicles.findById({ id: vehicleId });
    if (!vehicle || vehicle.status !== 'OUT_OF_SERVICE') return;
    await this.vehicles.update({ id: vehicleId }, { status: 'ACTIVE' });
    this.logger.log({ vehicleId }, 'Vehicle restored from OUT_OF_SERVICE — last open CRITICAL defect resolved');
    await this.events.publish('vehicle.restored_from_out_of_service', { vehicleId });
  }
}
