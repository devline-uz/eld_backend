import { Injectable } from '@nestjs/common';
import type { Driver, DriverDocument, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface DriverListFilter {
  status?: Driver['status'];
  q?: string;
}

export interface DriverRosterFilter extends DriverListFilter {
  terminal?: string;
  hasOpenViolation?: boolean;
  exempt?: boolean;
}

export type DriverWithUnit = Driver & { assignedVehicle: { id: string; unitNumber: string } | null };

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

  /** Live (not soft-deleted) driver only — `username` is unique among live rows via a partial
   * unique index (migration 20260927090000_soft_delete_partial_uniques), so a deleted driver's
   * username is free for reuse. */
  findByUsername(username: string): Promise<Driver | null> {
    return this.prisma.driver.findFirst({ where: { username, deletedAt: null } });
  }

  /** §20 B-29/B-30 — `Driver.email` is unique among live rows (partial unique index); checked
   * pre-write so a collision surfaces as a clean `CONFLICT` instead of an unhandled `P2002`. */
  findByEmail(email: string): Promise<Driver | null> {
    return this.prisma.driver.findFirst({ where: { email, deletedAt: null } });
  }

  async list(
    filter: DriverListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<DriverListPage> {
    const where: Prisma.DriverWhereInput = {
      deletedAt: null,
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

  /** `GET /drivers/roster` — the driver page plus its assigned unit, with the B-55 filters. */
  async listRoster(
    filter: DriverRosterFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<{ items: DriverWithUnit[]; total: number }> {
    const where: Prisma.DriverWhereInput = {
      deletedAt: null,
      ...(filter.status && { status: filter.status }),
      ...(filter.terminal && { homeTerminalName: { equals: filter.terminal, mode: 'insensitive' } }),
      ...(filter.exempt !== undefined && { eldExempt: filter.exempt }),
      ...(filter.hasOpenViolation === true && { violations: { some: { status: 'OPEN' } } }),
      ...(filter.hasOpenViolation === false && { violations: { none: { status: 'OPEN' } } }),
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
    const scoped = this.scopeWhere(where);
    const [items, total] = await Promise.all([
      this.prisma.driver.findMany({
        where: scoped,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: { assignedVehicle: { select: { id: true, unitNumber: true } } },
      }),
      this.prisma.driver.count({ where: scoped }),
    ]);
    return { items, total };
  }

  /** OPEN `HosViolation` rows per driver (AUTO_CLEARED / RESOLVED are not open). */
  async countOpenViolations(driverIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (driverIds.length === 0) return counts;
    const rows = await this.prisma.hosViolation.groupBy({
      by: ['driverId'],
      where: { driverId: { in: driverIds }, status: 'OPEN' },
      _count: { _all: true },
    });
    for (const row of rows) counts.set(row.driverId, row._count._all);
    return counts;
  }

  listAll(): Promise<Driver[]> {
    return this.prisma.driver.findMany({ where: { deletedAt: null }, orderBy: { username: 'asc' } });
  }

  // -------------------------------------------------------------------
  // §20 B-94 (tz.md §20 B-16) — driver qualification documents.
  // -------------------------------------------------------------------

  listDocuments(driverId: string): Promise<DriverDocument[]> {
    return this.prisma.driverDocument.findMany({ where: { driverId }, orderBy: { createdAt: 'desc' } });
  }

  findDocument(id: string): Promise<DriverDocument | null> {
    return this.prisma.driverDocument.findUnique({ where: { id } });
  }

  createDocument(data: Prisma.DriverDocumentCreateInput): Promise<DriverDocument> {
    return this.prisma.driverDocument.create({ data });
  }

  deleteDocument(id: string): Promise<DriverDocument> {
    return this.prisma.driverDocument.delete({ where: { id } });
  }

  /** B-094 — revokes every live `DriverSession` (refresh token) of one driver. */
  async revokeAllSessions(driverId: string): Promise<number> {
    const result = await this.prisma.driverSession.updateMany({
      where: { driverId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
