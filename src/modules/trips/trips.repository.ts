import { Injectable } from '@nestjs/common';
import type { Prisma, Trip } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

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

  createWithStops(data: Prisma.TripCreateInput, stops: Prisma.TripStopCreateWithoutTripInput[]) {
    return this.prisma.trip.create({
      data: { ...data, stops: stops.length ? { create: stops } : undefined },
      include: { stops: true, ...NAME_JOIN },
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
