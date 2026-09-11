import { Injectable } from '@nestjs/common';
import type { Driver, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface DriverListFilter {
  status?: Driver['status'];
  q?: string;
}

export interface DriverListPage {
  items: Driver[];
  total: number;
}

@Injectable()
export class DriversRepository extends BaseRepository<
  Driver,
  Prisma.DriverWhereInput,
  Prisma.DriverWhereUniqueInput,
  Prisma.DriverCreateInput,
  Prisma.DriverUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Driver,
    Prisma.DriverWhereInput,
    Prisma.DriverWhereUniqueInput,
    Prisma.DriverCreateInput,
    Prisma.DriverUpdateInput
  > {
    return this.prisma.driver;
  }

  findByUsername(username: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { username } });
  }

  async list(
    filter: DriverListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<DriverListPage> {
    const where: Prisma.DriverWhereInput = {
      ...(filter.status && { status: filter.status }),
      ...(filter.q && {
        OR: [
          { username: { contains: filter.q, mode: 'insensitive' } },
          { firstName: { contains: filter.q, mode: 'insensitive' } },
          { lastName: { contains: filter.q, mode: 'insensitive' } },
          { cdlNumber: { contains: filter.q, mode: 'insensitive' } },
          { email: { contains: filter.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.driver.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.driver.count({ where }),
    ]);
    return { items, total };
  }

  listAll(): Promise<Driver[]> {
    return this.prisma.driver.findMany({ orderBy: { username: 'asc' } });
  }
}
