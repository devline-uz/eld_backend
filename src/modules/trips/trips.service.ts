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
    if (existing) throw new AppException(ERROR_CODES.CONFLICT, 'A trip with this number already exists.', 409);

    const { stops, driverId, vehicleId, trailerId, draft, ...rest } = dto;
    if (trailerId) await this.assertTrailerAssignable(trailerId);
    const trip = await this.repo.createWithStops(
      {
        ...rest,
        // §20 B-73 — a draft always starts DRAFT, even with a driver on it (not yet published).
        status: draft ? 'DRAFT' : driverId ? 'ASSIGNED' : 'PLANNED',
        createdById,
        ...(driverId && { driver: { connect: { id: driverId } } }),
        ...(vehicleId && { vehicle: { connect: { id: vehicleId } } }),
        ...(trailerId && { trailerId }),
      },
      (stops ?? []).map((s) => ({ ...s })),
    );
    return trip;
  }

  async update(id: string, dto: UpdateTripDto) {
    const trip = await this.repo.findById({ id });
    if (!trip) throw new AppException(ERROR_CODES.NOT_FOUND, 'Trip not found.', 404);

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

    const data: Prisma.TripUpdateInput = { ...dto };
    if (dto.status === 'IN_PROGRESS' && !trip.startedAt) data.startedAt = new Date();
    if (dto.status === 'DELIVERED' && !trip.completedAt) data.completedAt = new Date();

    const updated = await this.repo.update({ id }, data);
    if (dto.status && dto.status !== trip.status) {
      await this.publishStatusChanged(updated.id, updated.status, updated.etaAt);
    }
    return updated;
  }

  async assign(id: string, dto: AssignTripDto) {
    const trip = await this.repo.findById({ id });
    if (!trip) throw new AppException(ERROR_CODES.NOT_FOUND, 'Trip not found.', 404);
    if (trip.status !== 'PLANNED' && trip.status !== 'ASSIGNED') {
      throw new AppException(ERROR_CODES.CONFLICT, 'Only a planned or assigned trip can be (re)assigned.', 409);
    }
    // Re-sending the trip's current trailer is fine even if it was deleted since; a NEW trailer must be live.
    if (dto.trailerId && dto.trailerId !== trip.trailerId) await this.assertTrailerAssignable(dto.trailerId);
    const updated = await this.repo.update(
      { id },
      {
        status: 'ASSIGNED',
        driver: { connect: { id: dto.driverId } },
        ...(dto.vehicleId && { vehicle: { connect: { id: dto.vehicleId } } }),
        ...(dto.trailerId && { trailerId: dto.trailerId }),
      },
    );
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
