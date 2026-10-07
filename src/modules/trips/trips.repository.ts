import { Injectable } from '@nestjs/common';
import type { Prisma, Trip } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { UNIT_BLOCKING_STATUSES } from './trip-schedule';

export interface TripListFilter {
  status?: Trip['status'];
  driverId?: string;
  q?: string;
}

/** §20 B-36 — minimal driver/vehicle name join, reused by `list`, `unassignedLoads` and
 * `getWithStops`. */
const NAME_JOIN = {
  driver: { select: { id: true, firstName: true, lastName: true } },
  vehicle: { select: { id: true, unitNumber: true } },
} as const;

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
  findTrailer(id: string): Promise<{ id: string; deletedAt: Date | null } | null> {
    return this.prisma.trailer.findUnique({ where: { id }, select: { id: true, deletedAt: true } });
  }

  async list(filter: TripListFilter, page: number, limit: number, orderBy: Record<string, 'asc' | 'desc'>) {
    const where: Prisma.TripWhereInput = {
      ...(filter.status && { status: filter.status }),
      ...(filter.driverId && { driverId: filter.driverId }),
      ...(filter.q && {
        OR: [
          { number: { contains: filter.q, mode: 'insensitive' } },
          { shippingDocument: { contains: filter.q, mode: 'insensitive' } },
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
   * Runs `work` in a transaction holding a per-unit advisory lock, so two concurrent web-panel
   * writes cannot both pass the overlap check for the same unit and both commit (same
   * `pg_advisory_xact_lock` pattern as ingest sequence allocation). Released on commit/rollback.
   */
  withUnitScheduleLock<T>(vehicleId: string, work: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, `trip-unit:${vehicleId}`);
      return work(tx);
    });
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
    return db.trip.findMany({
      where: {
        vehicleId,
        status: { in: [...UNIT_BLOCKING_STATUSES] },
        ...(excludeTripId && { id: { not: excludeTripId } }),
        AND: [
          {
            OR: [
              { status: 'IN_PROGRESS' },
              { plannedEndAt: null },
              { plannedEndAt: { gt: window.start } },
              { completedAt: { gt: window.start } },
            ],
          },
          ...(window.end
            ? [
                {
                  OR: [
                    { status: 'IN_PROGRESS' as const },
                    { plannedStartAt: { lt: window.end } },
                    { startedAt: { lt: window.end } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: { plannedStartAt: 'asc' },
      take: 50,
      select: {
        id: true,
        number: true,
        status: true,
        plannedStartAt: true,
        plannedEndAt: true,
        startedAt: true,
        completedAt: true,
        vehicle: { select: { unitNumber: true } },
      },
    });
  }

  /** Drivers currently ACTIVE with no trip in an unfinished state — used by auto-assign. */
  availableDriverIds(): Promise<string[]> {
    return this.prisma.driver
      .findMany({
        where: {
          status: 'ACTIVE',
          trips: { none: { status: { in: ['ASSIGNED', 'IN_PROGRESS'] } } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
      .then((rows) => rows.map((r) => r.id));
  }
}
