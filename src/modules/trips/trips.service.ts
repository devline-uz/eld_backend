import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage, parseSort } from '../../common/dto/list-query.dto';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { AssignTripDto, CreateTripDto, TripListQueryDto, UpdateTripDto } from './dto/trips.dto';
import { TripsRepository } from './trips.repository';
import {
  findScheduleConflict,
  formatScheduleInstant,
  UNIT_SCHEDULED_STATUSES,
  type TimeWindow,
} from './trip-schedule';

const PLANNED_END_MESSAGE = 'Planned end must be after planned start.';
const TRIP_NUMBER_TAKEN_MESSAGE = 'A trip with this number already exists.';

/** 409 `CONFLICT` keyed `details.number` so the web lands it under the "Trip / load ID" input
 * instead of a generic form-level banner. `Trip.number` is `@unique` (one carrier per database). */
function tripNumberTaken(): AppException {
  return AppException.conflict(TRIP_NUMBER_TAKEN_MESSAGE, { number: TRIP_NUMBER_TAKEN_MESSAGE });
}

/** Prisma `P2002` on `Trip.number` — a concurrent create that lost the race to the pre-check. */
function isTripNumberUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || (err as { code?: string }).code !== 'P2002') return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const names = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '';
  return /number/i.test(names);
}

function tripInProgress(): AppException {
  return new AppException(
    ERROR_CODES.TRIP_IN_PROGRESS,
    'This trip is in progress and cannot be deleted. Finish or cancel it first.',
    409,
    { status: 'IN_PROGRESS' },
  );
}

/** Statuses in which only `status` may be PATCHed (409 `TRIP_NOT_EDITABLE` otherwise). */
const NON_EDITABLE_STATUSES: string[] = ['DELIVERED', 'CANCELLED'];

/** Valid forward transitions of `Trip.status` (TZ §11.5 dispatch lifecycle).
 * §20 B-73 — `DRAFT` is the pre-publish state: `PATCH { status: 'PLANNED' }` publishes it. */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED', 'PLANNED'],
  IN_PROGRESS: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

@Injectable()
export class TripsService {
  constructor(
    private readonly repo: TripsRepository,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
  ) {}

  async list(query: TripListQueryDto): Promise<OffsetPage<unknown>> {
    const orderBy = parseSort(query.sort, ['plannedStartAt', 'number', 'status'] as const, { plannedStartAt: 'desc' });
    const { items, total } = await this.repo.list(
      { status: query.status, driverId: query.driverId, q: query.q },
      query.page,
      query.limit,
      orderBy,
    );
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) };
  }

  unassignedLoads() {
    return this.repo.unassignedLoads();
  }

  async get(id: string) {
    const trip = await this.repo.getWithStops(id);
    if (!trip) throw new AppException(ERROR_CODES.NOT_FOUND, 'Trip not found.', 404);
    return trip;
  }

  async create(dto: CreateTripDto, createdById: string) {
    const existing = await this.repo.findByNumber(dto.number);
    if (existing) throw tripNumberTaken();

    const { stops, driverId, vehicleId, trailerId, draft, ...rest } = dto;
    this.assertPlannedWindow(dto.plannedStartAt, dto.plannedEndAt);
    if (trailerId) await this.assertTrailerAssignable(trailerId);
    const data: Prisma.TripCreateInput = {
      ...rest,
      // §20 B-73 — a draft always starts DRAFT, even with a driver on it (not yet published).
      status: draft ? 'DRAFT' : driverId ? 'ASSIGNED' : 'PLANNED',
      createdById,
      ...(driverId && { driver: { connect: { id: driverId } } }),
      ...(vehicleId && { vehicle: { connect: { id: vehicleId } } }),
      ...(trailerId && { trailerId }),
    };
    const stopRows = (stops ?? []).map((s) => ({ ...s }));
    // Drafts included — a draft with a unit and a start reserves that unit (trip-schedule.ts).
    const window = this.windowOf(dto.plannedStartAt, dto.plannedEndAt);
    if (vehicleId && window) {
      return this.numberConflictOnDuplicate(
        this.repo.withUnitScheduleLock(vehicleId, async (db) => {
          await this.assertUnitFree(vehicleId, window, undefined, db);
          return this.repo.createWithStops(data, stopRows, db);
        }),
      );
    }
    return this.numberConflictOnDuplicate(this.repo.createWithStops(data, stopRows));
  }

  /** Surface a `Trip.number` unique-index race as the same 409 the pre-check throws, not a 500. */
  private async numberConflictOnDuplicate<T>(write: Promise<T>): Promise<T> {
    try {
      return await write;
    } catch (err) {
      if (isTripNumberUniqueViolation(err)) throw tripNumberTaken();
      throw err;
    }
  }

  async update(id: string, dto: UpdateTripDto) {
    const trip = await this.repo.findById({ id });
    if (!trip) throw new AppException(ERROR_CODES.NOT_FOUND, 'Trip not found.', 404);

    // A finished (DELIVERED/CANCELLED) trip is frozen: only `status` may be sent (and the
    // transition table below rejects every move out of a terminal state anyway).
    if (NON_EDITABLE_STATUSES.includes(trip.status)) {
      const editedFields = Object.entries(dto)
        .filter(([key, value]) => key !== 'status' && value !== undefined)
        .map(([key]) => key);
      if (editedFields.length > 0) {
        throw new AppException(
          ERROR_CODES.TRIP_NOT_EDITABLE,
          `A ${trip.status.toLowerCase()} trip cannot be edited.`,
          409,
          { status: trip.status, fields: editedFields },
        );
      }
    }

    if (dto.status && dto.status !== trip.status) {
      const allowed = ALLOWED_TRANSITIONS[trip.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new AppException(
          ERROR_CODES.CONFLICT,
          `Cannot move a trip from ${trip.status} to ${dto.status}.`,
          409,
          { from: trip.status, to: dto.status },
        );
      }
    }

    const timesChanged = dto.plannedStartAt !== undefined || dto.plannedEndAt !== undefined;
    const plannedStartAt = dto.plannedStartAt ?? trip.plannedStartAt;
    const plannedEndAt = dto.plannedEndAt ?? trip.plannedEndAt;
    if (timesChanged) this.assertPlannedWindow(plannedStartAt, plannedEndAt);

    const data: Prisma.TripUpdateInput = { ...dto };
    if (dto.status === 'IN_PROGRESS' && !trip.startedAt) data.startedAt = new Date();
    if (dto.status === 'DELIVERED' && !trip.completedAt) data.completedAt = new Date();

    // Re-check the unit when the trip's range moves, or when a draft is published (a draft saved
    // before this rule existed may overlap). Plain status moves keep the range, so no re-check.
    const nextStatus = dto.status ?? trip.status;
    const publishing = trip.status === 'DRAFT' && nextStatus !== 'DRAFT';
    const window = this.windowOf(plannedStartAt, plannedEndAt);
    const vehicleId = trip.vehicleId;
    const updated =
      vehicleId && window && (timesChanged || publishing) && UNIT_SCHEDULED_STATUSES.includes(nextStatus)
        ? await this.repo.withUnitScheduleLock(vehicleId, async (db) => {
            await this.assertUnitFree(vehicleId, window, id, db);
            return this.repo.update({ id }, data, db);
          })
        : await this.repo.update({ id }, data);
    if (dto.status && dto.status !== trip.status) {
      await this.publishStatusChanged(updated.id, updated.status, updated.etaAt);
    }
    return updated;
  }

  /**
   * Web-panel hard delete — the row (and its stops) is removed so `Trip.number` can be reused.
   * 404 when unknown, 409 `TRIP_IN_PROGRESS` while the driver is running it on mobile.
   */
  async remove(id: string): Promise<void> {
    const trip = await this.repo.findById({ id });
    if (!trip) throw new AppException(ERROR_CODES.NOT_FOUND, 'Trip not found.', 404);
    if (trip.status === 'IN_PROGRESS') throw tripInProgress();

    const deleted = await this.repo.hardDelete(id);
    if (!deleted) {
      // Lost a race: either someone else deleted it, or the driver started it meanwhile.
      const current = await this.repo.findById({ id });
      if (!current) throw new AppException(ERROR_CODES.NOT_FOUND, 'Trip not found.', 404);
      throw tripInProgress();
    }
    await this.events.publish('realtime.push', {
      room: 'fleet',
      event: 'trip.deleted',
      payload: { id, tripId: id },
    });
  }

  async assign(id: string, dto: AssignTripDto) {
    const trip = await this.repo.findById({ id });
    if (!trip) throw new AppException(ERROR_CODES.NOT_FOUND, 'Trip not found.', 404);
    if (trip.status !== 'PLANNED' && trip.status !== 'ASSIGNED') {
      throw new AppException(ERROR_CODES.CONFLICT, 'Only a planned or assigned trip can be (re)assigned.', 409);
    }
    // Re-sending the trip's current trailer is fine even if it was deleted since; a NEW trailer must be live.
    if (dto.trailerId && dto.trailerId !== trip.trailerId) await this.assertTrailerAssignable(dto.trailerId);
    const data: Prisma.TripUpdateInput = {
      status: 'ASSIGNED',
      driver: { connect: { id: dto.driverId } },
      ...(dto.vehicleId && { vehicle: { connect: { id: dto.vehicleId } } }),
      ...(dto.trailerId && { trailerId: dto.trailerId }),
    };
    // Moving the trip onto a different unit must not double-book that unit.
    const newVehicleId = dto.vehicleId && dto.vehicleId !== trip.vehicleId ? dto.vehicleId : null;
    const window = this.windowOf(trip.plannedStartAt, trip.plannedEndAt);
    const updated =
      newVehicleId && window
        ? await this.repo.withUnitScheduleLock(newVehicleId, async (db) => {
            await this.assertUnitFree(newVehicleId, window, id, db);
            return this.repo.update({ id }, data, db);
          })
        : await this.repo.update({ id }, data);
    await this.publishStatusChanged(updated.id, updated.status, updated.etaAt);
    // §20 B-74 — `notify: false` skips the driver-app assignment notification entirely.
    if (dto.notify) {
      await this.alertQueue.add('alert.trip_assigned', { tripId: updated.id, driverId: dto.driverId });
    }
    return updated;
  }

  /** TZ §11.5 `POST /trips/auto-assign` — greedy: first unassigned load to first free driver. */
  async autoAssign(): Promise<{ assigned: Array<{ tripId: string; driverId: string }>; skipped: number }> {
    const loads = await this.repo.unassignedLoads();
    const driverIds = await this.repo.availableDriverIds();
    const assigned: Array<{ tripId: string; driverId: string }> = [];
    const pool = [...driverIds];
    for (const load of loads) {
      const driverId = pool.shift();
      if (!driverId) break;
      await this.assign(load.id, { driverId, notify: true });
      assigned.push({ tripId: load.id, driverId });
    }
    return { assigned, skipped: loads.length - assigned.length };
  }

  /** 422 unless the planned end (when both are set) is strictly after the planned start. */
  private assertPlannedWindow(start: Date | null | undefined, end: Date | null | undefined): void {
    if (start && end && end.getTime() <= start.getTime()) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, PLANNED_END_MESSAGE, 422, { plannedEndAt: PLANNED_END_MESSAGE });
    }
  }

  /** The range a trip asks its unit for; `null` (nothing to check) when it has no planned start. */
  private windowOf(start: Date | null | undefined, end: Date | null | undefined): TimeWindow | null {
    return start ? { start, end: end ?? null } : null;
  }

  /**
   * 409 `TRIP_SCHEDULE_CONFLICT` when another live trip already holds `vehicleId` for any part of
   * `window` (touching endpoints are fine). Web-panel `/trips` only — the mobile/tablet trip
   * endpoints use their own repository and never reach this.
   */
  private async assertUnitFree(
    vehicleId: string,
    window: TimeWindow,
    excludeTripId: string | undefined,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const candidates = await this.repo.findUnitScheduleCandidates(vehicleId, window, excludeTripId, db);
    const conflict = findScheduleConflict(window, candidates, excludeTripId);
    if (!conflict) return;
    const { trip, window: taken } = conflict;
    const unit = trip.vehicle?.unitNumber ? `Unit ${trip.vehicle.unitNumber}` : 'This unit';
    const range = taken.end
      ? `from ${formatScheduleInstant(taken.start)} to ${formatScheduleInstant(taken.end)}`
      : `from ${formatScheduleInstant(taken.start)} onward (no planned end)`;
    const message = `${unit} is already assigned to another trip (${trip.number}) ${range}.`;
    throw new AppException(ERROR_CODES.TRIP_SCHEDULE_CONFLICT, message, 409, {
      vehicleId: message,
      conflict: {
        tripId: trip.id,
        number: trip.number,
        status: trip.status,
        unitNumber: trip.vehicle?.unitNumber ?? null,
        start: taken.start.toISOString(),
        end: taken.end ? taken.end.toISOString() : null,
      },
    });
  }

  /** `Trip.trailerId` has no FK, so an unknown id would otherwise be stored silently; a
   * soft-deleted trailer stays readable on old trips but cannot be put on a trip anymore. */
  private async assertTrailerAssignable(trailerId: string): Promise<void> {
    const trailer = await this.repo.findTrailer(trailerId);
    if (!trailer) {
      throw new AppException(ERROR_CODES.TRAILER_NOT_FOUND, 'Trailer not found.', 422, { trailerId: 'Trailer not found.' });
    }
    if (trailer.deletedAt) {
      throw new AppException(ERROR_CODES.TRAILER_NOT_FOUND, 'This trailer has been deleted and cannot be assigned.', 422, {
        trailerId: 'This trailer has been deleted and cannot be assigned.',
      });
    }
  }

  private async publishStatusChanged(tripId: string, status: string, etaAt: Date | null): Promise<void> {
    await this.events.publish('realtime.push', {
      room: 'fleet',
      event: 'trip.status_changed',
      payload: { tripId, status, eta: etaAt },
    });
  }
}
