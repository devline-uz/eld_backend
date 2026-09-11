import { Injectable } from '@nestjs/common';
import type { Prisma, Trailer } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

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

  findByNumber(number: string): Promise<Trailer | null> {
    return this.prisma.trailer.findUnique({ where: { number } });
  }

  listAll(): Promise<Trailer[]> {
    return this.prisma.trailer.findMany({ orderBy: { number: 'asc' } });
  }
}
