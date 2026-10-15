import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Prisma, Trip } from '@prisma/client';
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
  type ScheduledTripLike,
  type TimeWindow,
} from './trip-schedule';

const PLANNED_END_MESSAGE = 'Planned end must be after planned start.';
const TRIP_NUMBER_TAKEN_MESSAGE = 'A trip with this number already exists.';

/** 409 `CONFLICT` keyed `details.number` so the web lands it under the "Trip / load ID" input
 * instead of a generic form-level banner. `Trip.number` is `@unique` (one carrier per database). */
function tripNumberTaken(): AppException {
  return AppException.conflict(TRIP_NUMBER_TAKEN_MESSAGE, { number: TRIP_NUMBER_TAKEN_MESSAGE });
}

/** BE-005 — a driver/unit/trailer on a (non-draft) trip needs a planned start, or the overlap
 * check has no range to test and the trip would silently double-book its resources. */
const START_REQUIRED_MESSAGE = 'Set a planned start before putting a driver, unit or trailer on this trip.';
function plannedStartRequired(): AppException {
  return new AppException(ERROR_CODES.VALIDATION_FAILED, START_REQUIRED_MESSAGE, 422, { plannedStartAt: START_REQUIRED_MESSAGE });
}

/** CODE-058 — a dispatched trip with no planned end held its driver, unit and trailer for ever
 * (an open-ended range overlaps every later trip). A trip that puts any of them on the schedule
 * now needs a planned delivery time too. Drafts still save without one. */
const END_REQUIRED_MESSAGE = 'Set a planned delivery time before putting a driver, unit or trailer on this trip.';
function plannedEndRequired(): AppException {
  return new AppException(ERROR_CODES.VALIDATION_FAILED, END_REQUIRED_MESSAGE, 422, { plannedEndAt: END_REQUIRED_MESSAGE });
}

/** BE-001 — Prisma `P2025` ("record to connect/update not found") lost a race to the pre-check. */
function isRecordNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2025';
}

/** Prisma `P2002` on `Trip.number` — a concurrent create that lost the race to the pre-check. */
function isTripNumberUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || (err as { code?: string }).code !== 'P2002') return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const names = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '';
  return /number/i.test(names);
}

type ScheduleResource = 'vehicle' | 'driver' | 'trailer';

/** The unit/driver/trailer a trip asks for; `null` = not on the trip / nothing to check. */
interface ScheduleHolders {
  vehicleId: string | null;
  driverId: string | null;
  trailerId: string | null;
}

interface ScheduleCandidate extends ScheduledTripLike {
  vehicle: { unitNumber: string } | null;
  driver: { firstName: string; lastName: string } | null;
}

const RESOURCE_FIELD: Record<ScheduleResource, string> = { vehicle: 'vehicleId', driver: 'driverId', trailer: 'trailerId' };

function driverNameOf(driver: { firstName: string; lastName: string } | null): string | null {
  const name = driver ? `${driver.firstName} ${driver.lastName}`.trim() : '';
  return name || null;
}

/**
 * 409 `TRIP_SCHEDULE_CONFLICT` — "`{subject}` is already assigned to another trip (`{number}`)
 * from … to …." keyed under the resource's form field (`vehicleId` / `driverId` / `trailerId`),
 * with `details.conflict` naming the resource and the trip that holds it.
 */
function scheduleConflict(
  resource: ScheduleResource,
  subject: string,
  { trip, window: taken }: { trip: ScheduleCandidate; window: TimeWindow },
  extra: { driverName?: string | null; trailerNumber?: string | null } = {},
): AppException {
  const range = taken.end
    ? `from ${formatScheduleInstant(taken.start)} to ${formatScheduleInstant(taken.end)}`
    : `from ${formatScheduleInstant(taken.start)} onward (no planned end)`;
  const message = `${subject} is already assigned to another trip (${trip.number}) ${range}.`;
  return new AppException(ERROR_CODES.TRIP_SCHEDULE_CONFLICT, message, 409, {
    [RESOURCE_FIELD[resource]]: message,
    conflict: {
      resource,
      tripId: trip.id,
      number: trip.number,
      status: trip.status,
      unitNumber: trip.vehicle?.unitNumber ?? null,
      ...(resource === 'driver' && { driverName: extra.driverName ?? null }),
      ...(resource === 'trailer' && { trailerNumber: extra.trailerNumber ?? null }),
      start: taken.start.toISOString(),
      end: taken.end ? taken.end.toISOString() : null,
    },
  });
}

function tripInProgress(): AppException {
  return new AppException(
    ERROR_CODES.TRIP_IN_PROGRESS,
    'This trip is in progress and cannot be deleted. Finish or cancel it first.',
    409,
    { status: 'IN_PROGRESS' },
  );
}

/** CODE-024 — the trip's status moved between the service's read and its write (the driver app
 * started/delivered it, or another dispatcher changed it): the write is refused, never applied
 * over the newer status. */
function tripStatusChanged(current: string): AppException {
  return new AppException(
    ERROR_CODES.CONFLICT,
    `This trip was changed by someone else (it is now ${current.toLowerCase().replace('_', ' ')}). Refresh and try again.`,
    409,
    { status: current },
  );
}

/** LIVE-003 — clock skew allowed on a dispatcher-entered delivery time. */
const COMPLETED_AT_SKEW_MS = 2 * 60_000;

function completedAtInvalid(message: string): AppException {
  return new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, { completedAt: message });
}

/** Statuses in which only `status` may be PATCHed (409 `TRIP_NOT_EDITABLE` otherwise). */
const NON_EDITABLE_STATUSES: string[] = ['DELIVERED', 'CANCELLED'];

/** Valid forward transitions of `Trip.status` (TZ §11.5 dispatch lifecycle).
 * §20 B-73 — `DRAFT` is the pre-publish state: `PATCH { status: 'PLANNED' }` publishes it
 * (CODE-005: a draft that already has a driver is stored as `ASSIGNED`, see `update`). */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED', 'PLANNED'],
  IN_PROGRESS: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/** CODE-055 — `POST /trips/auto-assign` result. `skipped` = loads left unassigned (no free driver
 * at that time, or no planned start / delivery time — `noSchedule` of them); `failed` = loads a non-schedule error
 * stopped (each reported, the run continues). */
export interface AutoAssignResult {
  assigned: Array<{ tripId: string; driverId: string }>;
  skipped: number;
  noSchedule: number;
  failed: Array<{ tripId: string; number: string; reason: string }>;
}

/** CODE-055 — candidates tried per load before it counts as skipped (bounds a large fleet). */
const AUTO_ASSIGN_MAX_TRIES = 25;

/** CODE-055 — an `assign` failure that is about THIS driver (overlapping trip, gone, not ACTIVE):
 * auto-assign tries the next driver. Anything else is about the load and is reported for it. */
function isDriverSpecificFailure(err: unknown): boolean {
  if (!(err instanceof AppException)) return false;
  if (err.code === ERROR_CODES.TRIP_SCHEDULE_CONFLICT || err.code === ERROR_CODES.DRIVER_NOT_FOUND) return true;
  const details = err.details;
  return err.code === ERROR_CODES.CONFLICT && details !== undefined && 'driverId' in details;
}

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
    if (driverId) await this.assertDriverAssignable(driverId);
    if (vehicleId) await this.assertVehicleAssignable(vehicleId);
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
    // Drafts included — a draft with a unit/driver/trailer and a start reserves them (trip-schedule.ts).
    const window = this.windowOf(dto.plannedStartAt, dto.plannedEndAt);
    const holders = { vehicleId: vehicleId ?? null, driverId: driverId ?? null, trailerId: trailerId ?? null };
    // BE-005 — a drafted trip may still be incomplete; it is checked again when published.
    if (!window && !draft && this.hasHolder(holders)) throw plannedStartRequired();
    if (window && !window.end && !draft && this.hasHolder(holders)) throw plannedEndRequired();
    const created =
      window && this.hasHolder(holders)
        ? await this.numberConflictOnDuplicate(
            this.withScheduleLocks(holders, async (db) => {
              await this.assertHoldersFree(holders, window, undefined, db);
              return this.repo.createWithStops(data, stopRows, db);
            }),
          )
        : await this.numberConflictOnDuplicate(this.repo.createWithStops(data, stopRows));
    // CODE-056 — other dispatchers' boards learn of the new trip (they used to stay stale).
    await this.publishTripChanged('trip.created', created.id);
    return created;
  }

  /** Surface a `Trip.number` unique-index race as the same 409 the pre-check throws, and a
   * driver/unit deleted between the pre-check and the write (`P2025`) as a 422, never a 500. */
  private async numberConflictOnDuplicate<T>(write: Promise<T>): Promise<T> {
    try {
      return await write;
    } catch (err) {
      if (isTripNumberUniqueViolation(err)) throw tripNumberTaken();
      if (isRecordNotFound(err)) throw this.relationGone();
      throw err;
    }
  }

  /** BE-001 — `P2025` on a trip update/assign: the trip itself vanished (hard delete race) → 404;
   * CODE-024 — its status is no longer the one the write was guarded on → 409; otherwise the
   * driver/unit being connected did → 422. */
  private async mapUpdateError<T>(id: string, expectedStatus: string, write: Promise<T>): Promise<T> {
    try {
      return await write;
    } catch (err) {
      if (!isRecordNotFound(err)) throw err;
      const current = await this.repo.findById({ id });
      if (!current) throw new AppException(ERROR_CODES.NOT_FOUND, 'Trip not found.', 404);
      if (current.status !== expectedStatus) throw tripStatusChanged(current.status);
      throw this.relationGone();
    }
  }

  private relationGone(): AppException {
    const message = 'The selected driver or unit no longer exists.';
    return new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, { driverId: message, vehicleId: message });
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
      // BE-011 — ASSIGNED means "has a driver": a plain PATCH cannot get there without one
      // (`POST /trips/:id/assign` is the way to add the driver).
      if (dto.status === 'ASSIGNED' && !trip.driverId) {
        const message = 'Assign a driver to this trip before marking it assigned.';
        throw new AppException(ERROR_CODES.CONFLICT, message, 409, { from: trip.status, to: dto.status, driverId: message });
      }
    }

    if (dto.completedAt !== undefined) this.assertCompletedAt(trip, dto);

    const timesChanged = dto.plannedStartAt !== undefined || dto.plannedEndAt !== undefined;
    const plannedStartAt = dto.plannedStartAt ?? trip.plannedStartAt;
    const plannedEndAt = dto.plannedEndAt ?? trip.plannedEndAt;
    if (timesChanged) this.assertPlannedWindow(plannedStartAt, plannedEndAt);

    const data: Prisma.TripUpdateInput = { ...dto };
    // BE-011 — ASSIGNED -> PLANNED is an unassign: the driver comes off the trip (it is back on
    // the unassigned-loads board, which lists PLANNED trips with no driver).
    if (trip.status === 'ASSIGNED' && dto.status === 'PLANNED' && trip.driverId) data.driver = { disconnect: true };
    // CODE-005 — publishing a draft that already names a driver dispatches it: it goes straight to
    // ASSIGNED (what `create` does for a non-draft trip with a driver), never to a driver-holding
    // PLANNED trip that neither the unassigned-loads board (`driverId: null`) nor the driver app
    // (ASSIGNED / IN_PROGRESS only) would ever show. A draft without a driver still lands PLANNED.
    if (trip.status === 'DRAFT' && dto.status === 'PLANNED' && trip.driverId) data.status = 'ASSIGNED';
    if (dto.status === 'IN_PROGRESS' && !trip.startedAt) data.startedAt = new Date();
    // LIVE-003 — "Mark delivered" may record the actual delivery time (`completedAt`, checked above).
    if (dto.status === 'DELIVERED' && !dto.completedAt && !trip.completedAt) data.completedAt = new Date();
    // LIVE-003 — `Trip.onTime` was never written, so every delivery counted as on time on the web
    // KPI. Stamp it on delivery from the actual vs planned end (left alone without a planned end).
    if (dto.status === 'DELIVERED' && trip.onTime == null && trip.plannedEndAt) {
      const completedAt = (data.completedAt as Date | undefined) ?? (trip.completedAt as Date);
      data.onTime = completedAt.getTime() <= trip.plannedEndAt.getTime();
    }

    // Re-check the unit, driver and trailer when the trip's range moves, when a draft is published
    // (a draft saved before this rule existed may overlap) or when the trip becomes ASSIGNED. Plain
    // status moves keep the range, so no re-check. PATCH cannot change who/what is on the trip —
    // `assign` does that.
    const nextStatus = (data.status as Trip['status'] | undefined) ?? trip.status;
    const publishing = trip.status === 'DRAFT' && nextStatus !== 'DRAFT';
    // CODE-005 — the trip is being dispatched to its driver (a published draft with a driver, or
    // PATCH PLANNED -> ASSIGNED on a trip that already has one): same gates as `assign`.
    const assigning = nextStatus === 'ASSIGNED' && trip.status !== 'ASSIGNED' && Boolean(trip.driverId);
    const window = this.windowOf(plannedStartAt, plannedEndAt);
    const unassigning = data.driver !== undefined;
    const holders = {
      vehicleId: trip.vehicleId,
      driverId: unassigning ? null : trip.driverId,
      trailerId: trip.trailerId,
    };
    // BE-005 — publishing a draft that holds a driver/unit/trailer needs a range to check
    // (cancelling a draft puts nothing on the schedule, so it needs none).
    if (publishing && nextStatus !== 'CANCELLED' && !window && this.hasHolder(holders)) throw plannedStartRequired();
    // CODE-058 — publishing or dispatching needs a planned end too (a plain status move of a trip
    // that is already live does not; an IN_PROGRESS trip without one is really on the road).
    if (((publishing && nextStatus !== 'CANCELLED') || assigning) && window && !window.end && this.hasHolder(holders)) {
      throw plannedEndRequired();
    }
    // CODE-005 — a draft only had its driver/unit/trailer checked when it was saved; they may have
    // been deactivated, put out of service or deleted since. Re-check them before it goes live.
    // LIVE-012 / LIVE-033 — "Start trip" puts the driver, unit and trailer on the road now: they
    // must still be in service and not already on another trip at this moment (e.g. one still
    // IN_PROGRESS past its planned end).
    const starting = nextStatus === 'IN_PROGRESS' && trip.status !== 'IN_PROGRESS';
    if ((publishing && nextStatus !== 'CANCELLED') || assigning || starting) await this.assertHoldersAssignable(holders);
    // "At this moment" as a ±1 s window: an overrunning IN_PROGRESS trip occupies up to `now`.
    const startNow = Date.now();
    const checkWindow = starting ? { start: new Date(startNow - 1000), end: new Date(startNow + 1000) } : window;
    // CODE-024 — the write is guarded on the status read above, so a concurrent move (the driver
    // starting the trip, another dispatcher cancelling it) is a 409, never silently overwritten.
    const guard = { id, status: trip.status };
    // FE-15 — an edited pickup / delivery window also moves the first PICKUP / last DELIVERY stop.
    const stopTimes = timesChanged ? { pickupAt: dto.plannedStartAt, deliveryAt: dto.plannedEndAt } : undefined;
    const updated = await this.mapUpdateError(
      id,
      trip.status,
      checkWindow && this.hasHolder(holders) && (timesChanged || publishing || assigning || starting) && UNIT_SCHEDULED_STATUSES.includes(nextStatus)
        ? this.withScheduleLocks(holders, async (db) => {
            await this.assertHoldersFree(holders, checkWindow, id, db);
            return stopTimes ? this.repo.update(guard, data, db, stopTimes) : this.repo.update(guard, data, db);
          })
        : stopTimes
          ? this.repo.update(guard, data, undefined, stopTimes)
          : this.repo.update(guard, data),
    );
    if (nextStatus !== trip.status) {
      await this.publishStatusChanged(updated.id, updated.status, updated.etaAt);
    } else {
      // CODE-056 — a time / stop / reference edit keeps the status, so `trip.status_changed` never
      // fired and other boards kept the old times.
      await this.publishTripChanged('trip.updated', updated.id);
    }
    // CODE-005 — the same driver-app notification `assign` raises (`notify` defaults to true there).
    if (assigning && trip.driverId) {
      await this.alertQueue.add('alert.trip_assigned', { tripId: updated.id, driverId: trip.driverId });
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
    // Re-sending the trip's current driver/unit/trailer is fine even if it changed since; a NEW one
    // must be live and assignable (BE-001: unknown -> 422, soft-deleted -> 422, inactive/OOS -> 409).
    if (dto.driverId !== trip.driverId) await this.assertDriverAssignable(dto.driverId);
    if (dto.vehicleId && dto.vehicleId !== trip.vehicleId) await this.assertVehicleAssignable(dto.vehicleId);
    if (dto.trailerId && dto.trailerId !== trip.trailerId) await this.assertTrailerAssignable(dto.trailerId);
    const data: Prisma.TripUpdateInput = {
      status: 'ASSIGNED',
      driver: { connect: { id: dto.driverId } },
      ...(dto.vehicleId && { vehicle: { connect: { id: dto.vehicleId } } }),
      ...(dto.trailerId && { trailerId: dto.trailerId }),
    };
    // Moving the trip onto a different unit, driver or trailer must not double-book that one.
    const holders = {
      vehicleId: dto.vehicleId && dto.vehicleId !== trip.vehicleId ? dto.vehicleId : null,
      driverId: dto.driverId !== trip.driverId ? dto.driverId : null,
      trailerId: dto.trailerId && dto.trailerId !== trip.trailerId ? dto.trailerId : null,
    };
    const window = this.windowOf(trip.plannedStartAt, trip.plannedEndAt);
    // BE-005 — without a planned start the driver/unit overlap check cannot run.
    if (!window && this.hasHolder(holders)) throw plannedStartRequired();
    if (window && !window.end && this.hasHolder(holders)) throw plannedEndRequired();
    // CODE-024 — guarded on the PLANNED/ASSIGNED status checked above (see `update`).
    const guard = { id, status: trip.status };
    const updated = await this.mapUpdateError(
      id,
      trip.status,
      window && this.hasHolder(holders)
        ? this.withScheduleLocks(holders, async (db) => {
            await this.assertHoldersFree(holders, window, id, db);
            return this.repo.update(guard, data, db);
          })
        : this.repo.update(guard, data),
    );
    await this.publishStatusChanged(updated.id, updated.status, updated.etaAt);
    // §20 B-74 — `notify: false` skips the driver-app assignment notification entirely.
    if (dto.notify) {
      await this.alertQueue.add('alert.trip_assigned', { tripId: updated.id, driverId: dto.driverId });
    }
    return updated;
  }

  /** TZ §11.5 `POST /trips/auto-assign` — greedy: first unassigned load to first free driver. */
  /**
   * CODE-055 — greedy auto-assign, honest about what it did:
   * - a driver is a candidate when ACTIVE and not deleted; one with other trips is only ruled out
   *   for a load whose time overlaps (the same `assign` schedule check), not for any future trip;
   * - each load tries the candidates (least-loaded in this run first) until one fits;
   * - every load is its own atomic `assign`; a load that cannot be assigned is reported with the
   *   reason (`failed`) instead of aborting the run half-way with a 500;
   * - there is no HOS-hours check — `skipped` loads simply had no free driver at that time.
   */
  async autoAssign(): Promise<AutoAssignResult> {
    const loads = await this.repo.unassignedLoads();
    const candidates = await this.repo.availableDriverIds();
    const taken = new Map<string, number>(candidates.map((id) => [id, 0]));
    const result: AutoAssignResult = { assigned: [], skipped: 0, noSchedule: 0, failed: [] };
    for (const load of loads) {
      // BE-005 / CODE-058 — a load with no planned start or delivery time cannot be assigned.
      if (!load.plannedStartAt || !load.plannedEndAt) {
        result.noSchedule += 1;
        result.skipped += 1;
        continue;
      }
      const order = [...taken.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
      let placed = false;
      for (const driverId of order.slice(0, AUTO_ASSIGN_MAX_TRIES)) {
        try {
          await this.assign(load.id, { driverId, notify: true });
        } catch (err) {
          // This driver holds an overlapping trip or can no longer drive (inactive, deleted): try the next one.
          if (isDriverSpecificFailure(err)) continue;
          result.failed.push({ tripId: load.id, number: load.number, reason: err instanceof AppException ? err.message : 'Unexpected error.' });
          placed = true; // reported — do not also count it as skipped
          break;
        }
        taken.set(driverId, (taken.get(driverId) ?? 0) + 1);
        result.assigned.push({ tripId: load.id, driverId });
        placed = true;
        break;
      }
      if (!placed) result.skipped += 1;
    }
    return result;
  }

  /** LIVE-003 — a recorded delivery time only comes with the move to DELIVERED, is not in the
   * future and not before the trip started (422 keyed `completedAt`). */
  private assertCompletedAt(trip: Trip, dto: UpdateTripDto): void {
    const at = dto.completedAt as Date;
    if (dto.status !== 'DELIVERED' || trip.status === 'DELIVERED') {
      throw completedAtInvalid('A delivery time can only be set when marking the trip delivered.');
    }
    if (at.getTime() > Date.now() + COMPLETED_AT_SKEW_MS) throw completedAtInvalid('Delivery time cannot be in the future.');
    if (trip.startedAt && at.getTime() < trip.startedAt.getTime()) {
      throw completedAtInvalid('Delivery time cannot be before the trip started.');
    }
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

  private hasHolder(holders: ScheduleHolders): boolean {
    return Boolean(holders.vehicleId || holders.driverId || holders.trailerId);
  }

  /**
   * Runs `work` under the per-resource schedule locks, always nested vehicle → driver → trailer
   * (one fixed order, so two writers can never wait on each other's locks). A `null` id takes no
   * lock. All locks share the outermost lock's transaction, which `work` receives as `db`.
   */
  private withScheduleLocks<T>(holders: ScheduleHolders, work: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    // `outer` is passed only to the inner locks; the outermost one opens the transaction.
    type Lock = (inner: (db: Prisma.TransactionClient) => Promise<T>, ...outer: [Prisma.TransactionClient] | []) => Promise<T>;
    const { vehicleId, driverId, trailerId } = holders;
    const locks: Lock[] = [];
    if (vehicleId) locks.push((inner, ...outer) => this.repo.withUnitScheduleLock(vehicleId, inner, ...outer));
    if (driverId) locks.push((inner, ...outer) => this.repo.withDriverScheduleLock(driverId, inner, ...outer));
    if (trailerId) locks.push((inner, ...outer) => this.repo.withTrailerScheduleLock(trailerId, inner, ...outer));
    const run = (i: number, ...outer: [Prisma.TransactionClient] | []): Promise<T> =>
      locks[i]((db) => (i + 1 < locks.length ? run(i + 1, db) : work(db)), ...outer);
    return run(0);
  }

  /** Runs every applicable overlap check (vehicle, then driver, then trailer); first conflict wins. */
  private async assertHoldersFree(
    holders: ScheduleHolders,
    window: TimeWindow,
    excludeTripId: string | undefined,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    if (holders.vehicleId) {
      // CODE-062 — re-read the unit under its schedule lock: a delete that won the race (it takes
      // the same lock, `VehiclesRepository.softDeleteUnlessBooked`) must not get a trip after it.
      const unit = await this.repo.findVehicleForTrip(holders.vehicleId, db);
      if (!unit || unit.deletedAt) {
        const message = 'This unit has been deleted and cannot be assigned.';
        throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, message, 422, { vehicleId: message });
      }
      await this.assertUnitFree(holders.vehicleId, window, excludeTripId, db);
    }
    if (holders.driverId) {
      // CODE-062 (driver side) — driver delete takes `trip-driver:<id>` and re-checks open trips
      // (`DriversRepository.softDeleteUnlessOnTrip`); re-read the driver under that same lock so a
      // delete / deactivation that committed first is refused with the pre-check's 422 / 409.
      await this.assertDriverAssignable(holders.driverId, db);
      await this.assertDriverFree(holders.driverId, window, excludeTripId, db);
    }
    if (holders.trailerId) {
      // BE-06 — trailer delete / out-of-service takes `trip-trailer:<id>` and re-checks open trips
      // (`TrailersRepository.updateUnlessBooked`); re-read the trailer under that same lock so a
      // write that committed first is refused with the pre-check's 422 / 409.
      await this.assertTrailerAssignable(holders.trailerId, db);
      await this.assertTrailerFree(holders.trailerId, window, excludeTripId, db);
    }
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
    const unit = conflict.trip.vehicle?.unitNumber ? `Unit ${conflict.trip.vehicle.unitNumber}` : 'This unit';
    throw scheduleConflict('vehicle', unit, conflict);
  }

  /** Driver twin of `assertUnitFree`: one driver cannot be on two overlapping trips. */
  private async assertDriverFree(
    driverId: string,
    window: TimeWindow,
    excludeTripId: string | undefined,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const candidates = await this.repo.findDriverScheduleCandidates(driverId, window, excludeTripId, db);
    const conflict = findScheduleConflict(window, candidates, excludeTripId);
    if (!conflict) return;
    const driverName = driverNameOf(conflict.trip.driver);
    throw scheduleConflict('driver', driverName ? `Driver ${driverName}` : 'This driver', conflict, { driverName });
  }

  /** Trailer twin of `assertUnitFree`: one trailer cannot be on two overlapping trips. */
  private async assertTrailerFree(
    trailerId: string,
    window: TimeWindow,
    excludeTripId: string | undefined,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const candidates = await this.repo.findTrailerScheduleCandidates(trailerId, window, excludeTripId, db);
    const conflict = findScheduleConflict(window, candidates, excludeTripId);
    if (!conflict) return;
    // `Trip.trailerId` has no relation, so the number comes from the trailer row itself.
    const trailerNumber = await this.repo.findTrailerNumber(trailerId, db);
    throw scheduleConflict('trailer', trailerNumber ? `Trailer ${trailerNumber}` : 'This trailer', conflict, { trailerNumber });
  }

  /** CODE-005 — every driver/unit/trailer already on the trip must still be assignable. */
  private async assertHoldersAssignable(holders: ScheduleHolders): Promise<void> {
    if (holders.driverId) await this.assertDriverAssignable(holders.driverId);
    if (holders.vehicleId) await this.assertVehicleAssignable(holders.vehicleId);
    if (holders.trailerId) await this.assertTrailerAssignable(holders.trailerId);
  }

  /** BE-001 — the driver must exist and be live (422, keyed `driverId` like the trailer check) and
   * ACTIVE (409: an INACTIVE/TERMINATED driver cannot be dispatched). */
  private async assertDriverAssignable(driverId: string, db?: Prisma.TransactionClient): Promise<void> {
    const driver = await this.repo.findDriverForTrip(driverId, db);
    if (!driver || driver.deletedAt) {
      const message = driver ? 'This driver has been deleted and cannot be assigned.' : 'Driver not found.';
      throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, message, 422, { driverId: message });
    }
    if (driver.status !== 'ACTIVE') {
      const message = `This driver is ${driver.status.toLowerCase()} and cannot be assigned a trip.`;
      throw new AppException(ERROR_CODES.CONFLICT, message, 409, { driverId: message });
    }
  }

  /** BE-001 — the unit must exist and be live (422) and in service (409 `VEHICLE_OUT_OF_SERVICE`,
   * the same hard rule as `POST /vehicles/:id/assign-driver`); an INACTIVE unit is a 409 too. */
  private async assertVehicleAssignable(vehicleId: string): Promise<void> {
    const vehicle = await this.repo.findVehicleForTrip(vehicleId);
    if (!vehicle || vehicle.deletedAt) {
      const message = vehicle ? 'This unit has been deleted and cannot be assigned.' : 'Vehicle not found.';
      throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, message, 422, { vehicleId: message });
    }
    if (vehicle.status === 'OUT_OF_SERVICE') {
      const message = 'This unit is out of service and cannot be assigned a trip.';
      throw new AppException(ERROR_CODES.VEHICLE_OUT_OF_SERVICE, message, 409, { vehicleId: message });
    }
    if (vehicle.status !== 'ACTIVE') {
      const message = 'This unit is inactive and cannot be assigned a trip.';
      throw new AppException(ERROR_CODES.CONFLICT, message, 409, { vehicleId: message });
    }
  }

  /** `Trip.trailerId` has no FK, so an unknown id would otherwise be stored silently; a
   * soft-deleted trailer stays readable on old trips but cannot be put on a trip anymore. */
  private async assertTrailerAssignable(trailerId: string, db?: Prisma.TransactionClient): Promise<void> {
    const trailer = await this.repo.findTrailer(trailerId, db);
    if (!trailer) {
      throw new AppException(ERROR_CODES.TRAILER_NOT_FOUND, 'Trailer not found.', 422, { trailerId: 'Trailer not found.' });
    }
    if (trailer.deletedAt) {
      throw new AppException(ERROR_CODES.TRAILER_NOT_FOUND, 'This trailer has been deleted and cannot be assigned.', 422, {
        trailerId: 'This trailer has been deleted and cannot be assigned.',
      });
    }
    // CODE-049 — same in-service rule as the unit: an OOS / inactive trailer cannot go on a trip.
    if (trailer.status === 'OUT_OF_SERVICE') {
      const message = 'This trailer is out of service and cannot be assigned a trip.';
      throw new AppException(ERROR_CODES.CONFLICT, message, 409, { trailerId: message });
    }
    if (trailer.status !== 'ACTIVE') {
      const message = 'This trailer is inactive and cannot be assigned a trip.';
      throw new AppException(ERROR_CODES.CONFLICT, message, 409, { trailerId: message });
    }
  }

  /** CODE-056 — `fleet`-room notice that a trip was created or edited without a status move; the
   * web board refetches its slices (there is no row to patch for a new trip). */
  private async publishTripChanged(event: 'trip.created' | 'trip.updated', tripId: string): Promise<void> {
    await this.events.publish('realtime.push', { room: 'fleet', event, payload: { tripId } });
  }

  private async publishStatusChanged(tripId: string, status: string, etaAt: Date | null): Promise<void> {
    await this.events.publish('realtime.push', {
      room: 'fleet',
      event: 'trip.status_changed',
      payload: { tripId, status, eta: etaAt },
    });
  }
}
