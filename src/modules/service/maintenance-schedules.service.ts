import { Injectable } from '@nestjs/common';
import type { MaintenanceSchedule, Prisma } from '@prisma/client';
import { OffsetPage, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import {
  CompleteMaintenanceDto,
  CreateMaintenanceScheduleDto,
  MaintenanceScheduleListQueryDto,
  UpdateMaintenanceScheduleDto,
} from './dto/service.dto';
import { computeDue, DueResult } from './maintenance-due';
import { MaintenanceSchedulesRepository } from './maintenance-schedules.repository';

export interface ScheduleWithDue extends MaintenanceSchedule {
  due: DueResult;
}

/** TZ §5.10 — interval-by-mileage/engine-hours/date maintenance schedules with due/overdue
 * detection. Engine-hours interval is not modeled separately in the schema (`intervalMi` /
 * `intervalDays` only); a shop that schedules by hours converts to an equivalent mileage
 * interval when creating the schedule (documented — see decisions.md). */
@Injectable()
export class MaintenanceSchedulesService {
  constructor(
    private readonly repo: MaintenanceSchedulesRepository,
    private readonly vehicles: VehiclesRepository,
  ) {}

  async list(query: MaintenanceScheduleListQueryDto): Promise<OffsetPage<ScheduleWithDue>> {
    if (query.dueOnly) {
      const all = await this.repo.listEnabledWithVehicle();
      const now = new Date();
      const due = all
        .filter((s) => (!query.vehicleId || s.vehicleId === query.vehicleId) && (!query.status || s.status === query.status))
        .map((s) => this.withDue(s, s.vehicle.odometerMi, now))
        .filter((s) => s.due.state !== 'OK');
      const start = (query.page - 1) * query.limit;
      return toOffsetPage(due.slice(start, start + query.limit), due.length, query.page, query.limit);
    }

    const { items, total } = await this.repo.list({ vehicleId: query.vehicleId, enabled: query.enabled, status: query.status }, query.page, query.limit);
    const withVehicleOdometer = await Promise.all(
      items.map(async (s) => {
        const vehicle = await this.vehicles.findById({ id: s.vehicleId });
        return this.withDue(s, vehicle?.odometerMi ?? 0, new Date());
      }),
    );
    return toOffsetPage(withVehicleOdometer, total, query.page, query.limit);
  }

  async get(id: string): Promise<ScheduleWithDue> {
    const schedule = await this.getOrThrow(id);
    const vehicle = await this.vehicles.findById({ id: schedule.vehicleId });
    return this.withDue(schedule, vehicle?.odometerMi ?? 0, new Date());
  }

  private async getOrThrow(id: string): Promise<MaintenanceSchedule> {
    const schedule = await this.repo.findById({ id });
    if (!schedule) throw new AppException(ERROR_CODES.MAINTENANCE_SCHEDULE_NOT_FOUND, 'Maintenance schedule not found.', 404, { id });
    return schedule;
  }

  async create(dto: CreateMaintenanceScheduleDto): Promise<MaintenanceSchedule> {
    const vehicle = await this.vehicles.findById({ id: dto.vehicleId });
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId: dto.vehicleId });

    const lastServiceAt = dto.lastServiceAt ? new Date(dto.lastServiceAt) : null;
    const due = computeDue({
      intervalMi: dto.intervalMi ?? null,
      intervalDays: dto.intervalDays ?? null,
      lastServiceMi: dto.lastServiceMi ?? null,
      lastServiceAt,
      currentOdometerMi: vehicle.odometerMi,
      now: new Date(),
    });

    return this.repo.create({
      vehicle: { connect: { id: dto.vehicleId } },
      name: dto.name,
      ...(dto.scheduleType !== undefined && { scheduleType: dto.scheduleType }),
      intervalMi: dto.intervalMi ?? null,
      intervalDays: dto.intervalDays ?? null,
      lastServiceMi: dto.lastServiceMi ?? null,
      lastServiceAt,
      nextDueMi: due.nextDueMi,
      nextDueAt: due.nextDueAt,
      enabled: dto.enabled,
    });
  }

  async update(id: string, dto: UpdateMaintenanceScheduleDto, actorId?: string): Promise<MaintenanceSchedule> {
    const schedule = await this.getOrThrow(id);
    const vehicle = await this.vehicles.findById({ id: schedule.vehicleId });

    // M-40 — a rejection is only useful to the driver with the reason.
    const reviewNote = dto.reviewNote === undefined ? undefined : dto.reviewNote?.trim() || null;
    if (dto.status === 'REJECTED' && !(reviewNote ?? schedule.reviewNote)) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'reviewNote is required when rejecting a submission.', 422, { reviewNote: 'Required with status REJECTED.' });
    }
    // Approving (-> COMPLETED) is "serviced now": same clock reset as `complete`, unless the caller
    // supplies the service point explicitly.
    const approving = dto.status === 'COMPLETED' && schedule.status !== 'COMPLETED';

    const intervalMi = dto.intervalMi !== undefined ? dto.intervalMi : schedule.intervalMi;
    const intervalDays = dto.intervalDays !== undefined ? dto.intervalDays : schedule.intervalDays;
    const lastServiceMi = dto.lastServiceMi ?? (approving ? (vehicle?.odometerMi ?? schedule.lastServiceMi) : schedule.lastServiceMi);
    const lastServiceAt = dto.lastServiceAt ? new Date(dto.lastServiceAt) : approving ? new Date() : schedule.lastServiceAt;

    const due = computeDue({
      intervalMi,
      intervalDays,
      lastServiceMi,
      lastServiceAt,
      currentOdometerMi: vehicle?.odometerMi ?? 0,
      now: new Date(),
    });

    const data: Prisma.MaintenanceScheduleUpdateInput = {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.scheduleType !== undefined && { scheduleType: dto.scheduleType }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(reviewNote !== undefined && { reviewNote }),
      ...(dto.status !== undefined && dto.status !== schedule.status && actorId && { reviewedBy: { connect: { id: actorId } }, reviewedAt: new Date() }),
      intervalMi,
      intervalDays,
      lastServiceMi,
      lastServiceAt,
      nextDueMi: due.nextDueMi,
      nextDueAt: due.nextDueAt,
      ...(dto.enabled !== undefined && { enabled: dto.enabled }),
    };
    return this.repo.update({ id }, data);
  }

  async remove(id: string): Promise<void> {
    await this.getOrThrow(id);
    await this.repo.delete({ id });
  }

  /** Marks the schedule serviced now — resets the interval clock. */
  async complete(id: string, dto: CompleteMaintenanceDto): Promise<MaintenanceSchedule> {
    const schedule = await this.getOrThrow(id);
    const vehicle = await this.vehicles.findById({ id: schedule.vehicleId });
    const lastServiceAt = dto.serviceAt ? new Date(dto.serviceAt) : new Date();
    const lastServiceMi = dto.serviceOdometerMi ?? vehicle?.odometerMi ?? schedule.lastServiceMi ?? 0;

    const due = computeDue({
      intervalMi: schedule.intervalMi,
      intervalDays: schedule.intervalDays,
      lastServiceMi,
      lastServiceAt,
      currentOdometerMi: vehicle?.odometerMi ?? 0,
      now: new Date(),
    });

    return this.repo.update(
      { id },
      { status: 'COMPLETED', lastServiceMi, lastServiceAt, nextDueMi: due.nextDueMi, nextDueAt: due.nextDueAt },
    );
  }

  /** TZ §5.10 — nightly sweep for `workers/maintenance-due.processor.ts`: every enabled
   * schedule that is currently DUE_SOON or OVERDUE, one row per (schedule, vehicle). */
  async sweepDue(): Promise<Array<{ scheduleId: string; vehicleId: string; name: string; state: DueResult['state'] }>> {
    const all = await this.repo.listEnabledWithVehicle();
    const now = new Date();
    return all
      .map((s) => ({ schedule: s, due: this.withDue(s, s.vehicle.odometerMi, now).due }))
      .filter((s) => s.due.state !== 'OK')
      .map((s) => ({ scheduleId: s.schedule.id, vehicleId: s.schedule.vehicleId, name: s.schedule.name, state: s.due.state }));
  }

  private withDue(schedule: MaintenanceSchedule, currentOdometerMi: number, now: Date): ScheduleWithDue {
    const due = computeDue({
      intervalMi: schedule.intervalMi,
      intervalDays: schedule.intervalDays,
      lastServiceMi: schedule.lastServiceMi,
      lastServiceAt: schedule.lastServiceAt,
      currentOdometerMi,
      now,
    });
    return { ...schedule, due };
  }
}
