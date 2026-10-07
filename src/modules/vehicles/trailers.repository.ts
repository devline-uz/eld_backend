import { Injectable } from '@nestjs/common';
import type { Prisma, Trailer } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

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
   * deleted trailer's number is free for reuse. */
  findByNumber(number: string): Promise<Trailer | null> {
    return this.prisma.trailer.findFirst({ where: { number, deletedAt: null } });
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
          { number: { contains: filter.q, mode: 'insensitive' } },
          { vin: { contains: filter.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.trailer.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.trailer.count({ where }),
    ]);
    return { items, total };
  }

  /** Live trailers only (export). */
  listAll(): Promise<Trailer[]> {
    return this.prisma.trailer.findMany({ where: { deletedAt: null }, orderBy: { number: 'asc' } });
  }
}
