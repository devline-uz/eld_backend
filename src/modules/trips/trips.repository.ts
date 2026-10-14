import { Injectable } from '@nestjs/common';
import type { Driver, Prisma, Trailer, Trip, Vehicle } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { containsInsensitive } from '../../common/text/insensitive';

export interface TripListFilter {
  status?: Trip['status'];
  driverId?: string;
  q?: string;
}

/** CODE-060 — `GET /trips/unassigned-loads` returns at most this many loads (soonest first). */
export const UNASSIGNED_LOADS_LIMIT = 500;

/** §20 B-36 — minimal driver/vehicle name join, reused by `list`, `unassignedLoads` and
 * `getWithStops`. */
const NAME_JOIN = {
  driver: { select: { id: true, firstName: true, lastName: true } },
  vehicle: { select: { id: true, unitNumber: true } },
} as const;

/** BE-002 — the per-status `OR` branches of the schedule-candidate pre-filter (exported for the spec). */
export function scheduleCandidateFilters(window: { start: Date; end: Date | null }): Prisma.TripWhereInput[] {
  const { start, end } = window;
  return [
    {
      status: { in: ['DRAFT', 'PLANNED', 'ASSIGNED'] },
      plannedStartAt: end ? { not: null, lt: end } : { not: null },
      OR: [{ plannedEndAt: null }, { plannedEndAt: { gt: start } }],
    },
    { status: 'IN_PROGRESS' },
    {
      status: 'DELIVERED',
      AND: [
        { OR: [{ completedAt: { gt: start } }, { completedAt: null, plannedEndAt: { gt: start } }] },
        ...(end ? [{ OR: [{ startedAt: { lt: end } }, { startedAt: null, plannedStartAt: { lt: end } }] }] : []),
      ],
    },
  ];
}

@Injectable()
export class TripsRepository extends BaseRepository<
  Trip,
  Prisma.TripWhereInput,
  Prisma.TripWhereUniqueInput,
  Prisma.TripCreateInput,
  Prisma.TripUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Trip,
    Prisma.TripWhereInput,
    Prisma.TripWhereUniqueInput,
    Prisma.TripCreateInput,
    Prisma.TripUpdateInput
  > {
    return this.prisma.trip;
  }

  findByNumber(number: string): Promise<Trip | null> {
    return this.prisma.trip.findUnique({ where: { number } });
  }

  /** Any trailer row, live or soft-deleted — the service decides (a deleted one is not assignable). */
  findTrailer(id: string): Promise<{ id: string; status: Trailer['status']; deletedAt: Date | null } | null> {
    return this.prisma.trailer.findUnique({ where: { id }, select: { id: true, status: true, deletedAt: true } });
  }

  /** BE-001 — the driver a trip write names (live or soft-deleted); the service decides. */
  findDriverForTrip(
    id: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<{ id: string; status: Driver['status']; deletedAt: Date | null } | null> {
    return db.driver.findUnique({ where: { id }, select: { id: true, status: true, deletedAt: true } });
  }

  /** BE-001 — the unit a trip write names (live or soft-deleted); the service decides. */
  findVehicleForTrip(
    id: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<{ id: string; status: Vehicle['status']; deletedAt: Date | null } | null> {
    return db.vehicle.findUnique({ where: { id }, select: { id: true, status: true, deletedAt: true } });
  }

  async list(filter: TripListFilter, page: number, limit: number, orderBy: Record<string, 'asc' | 'desc'>) {
    const where: Prisma.TripWhereInput = {
      ...(filter.status && { status: filter.status }),
      ...(filter.driverId && { driverId: filter.driverId }),
      ...(filter.q && {
        OR: [
          { number: containsInsensitive(filter.q) },
          { shippingDocument: containsInsensitive(filter.q) },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.trip.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit, include: { stops: true, ...NAME_JOIN } }),
      this.prisma.trip.count({ where }),
    ]);
    return { items, total };
  }

  /** §20 B-36 — pickup/delivery columns need `stops`; the board also gets a driver/vehicle
   * name join so a caller does not have to round-trip `/drivers` + `/vehicles` just for this
   * list (the web panel already does its own client-side join and ignores these extra keys). */
  unassignedLoads(): Promise<Trip[]> {
    return this.prisma.trip.findMany({
      where: { status: 'PLANNED', driverId: null },
      orderBy: { plannedStartAt: 'asc' },
      // CODE-060 — bounded like every other list (it was the whole table); soonest loads first.
      take: UNASSIGNED_LOADS_LIMIT,
      include: { stops: { orderBy: { sequence: 'asc' } }, ...NAME_JOIN },
    });
  }

  getWithStops(id: string) {
    return this.prisma.trip.findUnique({ where: { id }, include: { stops: { orderBy: { sequence: 'asc' } }, ...NAME_JOIN } });
  }

  createWithStops(
    data: Prisma.TripCreateInput,
    stops: Prisma.TripStopCreateWithoutTripInput[],
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return db.trip.create({
      data: { ...data, stops: stops.length ? { create: stops } : undefined },
      include: { stops: true, ...NAME_JOIN },
    });
  }

  /** Base `update`, optionally inside the unit-schedule transaction (`withUnitScheduleLock`). */
  override update(where: Prisma.TripWhereUniqueInput, data: Prisma.TripUpdateInput, db?: Prisma.TransactionClient): Promise<Trip> {
    return db ? db.trip.update({ where, data }) : super.update(where, data);
  }

  /**
   * Hard delete (no soft delete): the row is gone, so `Trip.number` is free for reuse. `TripStop`
   * rows are removed in the same transaction (the FK is also `ON DELETE CASCADE`). The status
   * guard is repeated in the `WHERE` so a trip that went IN_PROGRESS after the service's pre-check
   * is not deleted. Returns `false` when no row matched (gone, or now IN_PROGRESS).
   * Nothing else references `Trip` by FK; notifications/audit rows keep a plain `objectId` string.
   */
  hardDelete(id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.trip.deleteMany({ where: { id, status: { not: 'IN_PROGRESS' } } });
      if (count === 0) return false;
      // Defensive — the cascade already removed them; keeps intent explicit if the FK ever changes.
      await tx.tripStop.deleteMany({ where: { tripId: id } });
      return true;
    });
  }

  /**
   * Runs `work` in a transaction holding a per-unit advisory lock, so two concurrent web-panel
   * writes cannot both pass the overlap check for the same unit and both commit (same
   * `pg_advisory_xact_lock` pattern as ingest sequence allocation). Released on commit/rollback.
   * With `outer`, the lock is taken inside that transaction instead (nested locks share one tx).
   */
  withUnitScheduleLock<T>(
    vehicleId: string,
    work: (db: Prisma.TransactionClient) => Promise<T>,
    outer?: Prisma.TransactionClient,
  ): Promise<T> {
    return this.withScheduleLock(`trip-unit:${vehicleId}`, work, outer);
  }

  /** Per-driver twin of `withUnitScheduleLock` — guards the driver overlap check. */
  withDriverScheduleLock<T>(
    driverId: string,
    work: (db: Prisma.TransactionClient) => Promise<T>,
    outer?: Prisma.TransactionClient,
  ): Promise<T> {
    return this.withScheduleLock(`trip-driver:${driverId}`, work, outer);
  }

  /** Per-trailer twin of `withUnitScheduleLock` — guards the trailer overlap check. */
  withTrailerScheduleLock<T>(
    trailerId: string,
    work: (db: Prisma.TransactionClient) => Promise<T>,
    outer?: Prisma.TransactionClient,
  ): Promise<T> {
    return this.withScheduleLock(`trip-trailer:${trailerId}`, work, outer);
  }

  private withScheduleLock<T>(
    key: string,
    work: (db: Prisma.TransactionClient) => Promise<T>,
    outer?: Prisma.TransactionClient,
  ): Promise<T> {
    const lockAndWork = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, key);
      return work(tx);
    };
    return outer ? lockAndWork(outer) : this.prisma.$transaction(lockAndWork);
  }

  /**
   * Live trips on `vehicleId` that could overlap `[start, end)` (`end: null` = open-ended). A coarse
   * SQL pre-filter only — `findScheduleConflict` (trip-schedule.ts) applies the exact rule.
   */
  findUnitScheduleCandidates(
    vehicleId: string,
    window: { start: Date; end: Date | null },
    excludeTripId: string | undefined,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return this.findScheduleCandidates({ vehicleId }, window, excludeTripId, db);
  }

  /** Same as `findUnitScheduleCandidates`, for trips held by `driverId`. */
  findDriverScheduleCandidates(
    driverId: string,
    window: { start: Date; end: Date | null },
    excludeTripId: string | undefined,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return this.findScheduleCandidates({ driverId }, window, excludeTripId, db);
  }

  /** Same as `findUnitScheduleCandidates`, for trips pulling `trailerId`. */
  findTrailerScheduleCandidates(
    trailerId: string,
    window: { start: Date; end: Date | null },
    excludeTripId: string | undefined,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return this.findScheduleCandidates({ trailerId }, window, excludeTripId, db);
  }

  /** The trailer's display number (live or soft-deleted), for the trailer-conflict message. */
  async findTrailerNumber(trailerId: string, db: Prisma.TransactionClient = this.prisma): Promise<string | null> {
    const row = await db.trailer.findUnique({ where: { id: trailerId }, select: { number: true } });
    return row?.number ?? null;
  }

  /**
   * BE-002 — a status-aware pre-filter mirroring `occupancyOf` (trip-schedule.ts), so only trips
   * that can really overlap `window` come back and nothing has to be truncated:
   *  - DRAFT/PLANNED/ASSIGNED: planned start set, `plannedStartAt < end`, planned end open or `> start`;
   *  - IN_PROGRESS: always (its occupancy stretches to "now");
   *  - DELIVERED: `completedAt ?? plannedEndAt > start` and `startedAt ?? plannedStartAt < end` —
   *    an old delivered trip with no planned end is no longer treated as open-ended.
   * No `take`: the previous `take: 50` ordered by `plannedStartAt ASC` could drop the one real
   * conflict behind 50 stale rows. `findScheduleConflict` still applies the exact rule.
   */
  private findScheduleCandidates(
    holder: { vehicleId: string } | { driverId: string } | { trailerId: string },
    window: { start: Date; end: Date | null },
    excludeTripId: string | undefined,
    db: Prisma.TransactionClient,
  ) {
    return db.trip.findMany({
      where: {
        ...holder,
        ...(excludeTripId && { id: { not: excludeTripId } }),
        OR: scheduleCandidateFilters(window),
      },
      orderBy: { plannedStartAt: 'asc' },
      select: {
        id: true,
        number: true,
        status: true,
        plannedStartAt: true,
        plannedEndAt: true,
        startedAt: true,
        completedAt: true,
        vehicle: { select: { unitNumber: true } },
        driver: { select: { firstName: true, lastName: true } },
      },
    });
  }

  /**
   * Auto-assign candidates: live ACTIVE drivers. CODE-055 — a driver with an ASSIGNED / IN_PROGRESS
   * trip used to be excluded outright (any future trip blocked them); `assign` now decides per
   * load with the schedule-overlap check, so only the time window matters.
   */
  availableDriverIds(): Promise<string[]> {
    return this.prisma.driver
      .findMany({
        where: { status: 'ACTIVE', deletedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
      .then((rows) => rows.map((r) => r.id));
  }
}
