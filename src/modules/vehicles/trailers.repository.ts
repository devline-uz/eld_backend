import { Injectable } from '@nestjs/common';
import type { Prisma, Trailer } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { containsInsensitive, equalsInsensitive } from '../../common/text/insensitive';

export interface TrailerListFilter {
  q?: string;
  status?: Trailer['status'];
}

export interface TrailerListPage {
  items: Trailer[];
  total: number;
}

@Injectable()
export class TrailersRepository extends BaseRepository<
  Trailer,
  Prisma.TrailerWhereInput,
  Prisma.TrailerWhereUniqueInput,
  Prisma.TrailerCreateInput,
  Prisma.TrailerUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Trailer,
    Prisma.TrailerWhereInput,
    Prisma.TrailerWhereUniqueInput,
    Prisma.TrailerCreateInput,
    Prisma.TrailerUpdateInput
  > {
    return this.prisma.trailer;
  }

  /** Live (not soft-deleted) trailer only — `number` is unique among live rows via the partial
   * unique index `Trailer_number_live_key` (migration 20261007110000_trailer_soft_delete), so a
   * deleted trailer's number is free for reuse. BE-07 — compared trimmed and case-insensitively
   * (literal, like unit numbers), so `tr-01` is the same trailer as `TR-01`. The DB index still
   * compares the raw value; B3-06 adds `Trailer_number_upper_live_key` (migration 20261016090000) so a
   * racing create is a P2002 -> 409 too. */
  findByNumber(number: string): Promise<Trailer | null> {
    return this.prisma.trailer.findFirst({ where: { number: equalsInsensitive(number.trim()), deletedAt: null } });
  }

  async list(
    filter: TrailerListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<TrailerListPage> {
    const where: Prisma.TrailerWhereInput = {
      deletedAt: null,
      ...(filter.status && { status: filter.status }),
      ...(filter.q && {
        OR: [
          { number: containsInsensitive(filter.q) },
          { vin: containsInsensitive(filter.q) },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.trailer.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.trailer.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * BE-06 — the trailer twin of `VehiclesRepository.softDeleteUnlessBooked`: the write (a soft
   * delete, or a status change out of service) runs under the trailer's trip-schedule advisory lock
   * (the key `TripsRepository.withTrailerScheduleLock` takes) and re-checks open trips inside it, so
   * a trip created concurrently either lands first (and blocks the write with its number) or sees
   * the trailer deleted / out of service. Returns the open trips instead of writing when there are any.
   */
  updateUnlessBooked(
    id: string,
    data: Prisma.TrailerUpdateInput,
  ): Promise<{ updated: Trailer; openTrips: [] } | { updated: null; openTrips: Array<{ id: string; number: string; status: string }> }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, `trip-trailer:${id}`);
      const openTrips = await tx.trip.findMany({
        where: { trailerId: id, status: { in: ['DRAFT', 'PLANNED', 'ASSIGNED', 'IN_PROGRESS'] } },
        select: { id: true, number: true, status: true },
        orderBy: { plannedStartAt: 'asc' },
        take: 20,
      });
      if (openTrips.length > 0) return { updated: null, openTrips };
      const updated = await tx.trailer.update({ where: { id }, data });
      return { updated, openTrips: [] as [] };
    });
  }

  /** Live trailers only (export). */
  listAll(): Promise<Trailer[]> {
    return this.prisma.trailer.findMany({ where: { deletedAt: null }, orderBy: { number: 'asc' } });
  }
}
