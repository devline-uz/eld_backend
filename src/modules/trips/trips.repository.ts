import { Injectable } from '@nestjs/common';
import type { Prisma, Trip } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface TripListFilter {
  status?: Trip['status'];
  driverId?: string;
  q?: string;
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
      this.prisma.trip.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit, include: { stops: true } }),
      this.prisma.trip.count({ where }),
    ]);
    return { items, total };
  }

  unassignedLoads(): Promise<Trip[]> {
    return this.prisma.trip.findMany({
      where: { status: 'PLANNED', driverId: null },
      orderBy: { plannedStartAt: 'asc' },
    });
  }

  getWithStops(id: string) {
    return this.prisma.trip.findUnique({ where: { id }, include: { stops: { orderBy: { sequence: 'asc' } } } });
  }

  createWithStops(data: Prisma.TripCreateInput, stops: Prisma.TripStopCreateWithoutTripInput[]) {
    return this.prisma.trip.create({
      data: { ...data, stops: stops.length ? { create: stops } : undefined },
      include: { stops: true },
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
