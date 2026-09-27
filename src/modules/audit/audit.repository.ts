import { Injectable } from '@nestjs/common';
import type { AuditLog, EditorType, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface CreateAuditLogInput {
  actorId: string;
  actorType: EditorType;
  action: string;
  objectType: string;
  objectId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  detail?: string;
  ip?: string;
  userAgent?: string;
}

export interface AuditLogFilter {
  objectType?: string;
  objectId?: string;
  actorId?: string;
}

/**
 * TZ §18 — `AuditLog` is append-only at the DB level (`REVOKE UPDATE, DELETE`); this
 * repository only ever calls `create`/`findMany`/`count`, never `update`/`delete`, so it
 * cannot violate that guarantee even if a caller tried to.
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  insert(input: CreateAuditLogInput): Promise<AuditLog> {
    return this.prisma.auditLog.create({ data: input });
  }

  async list(filter: AuditLogFilter, limit: number, cursor?: string): Promise<{ items: AuditLog[]; nextCursor: string | null }> {
    const where: Prisma.AuditLogWhereInput = {
      ...(filter.objectType && { objectType: filter.objectType }),
      ...(filter.objectId && { objectId: filter.objectId }),
      ...(filter.actorId && { actorId: filter.actorId }),
    };
    const items = await this.prisma.auditLog.findMany({
      where,
      take: limit + 1,
      ...(cursor && { cursor: { id: BigInt(cursor) }, skip: 1 }),
      orderBy: { id: 'desc' },
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    return { items: page, nextCursor: hasMore ? String(page.at(-1)?.id) : null };
  }

  /**
   * B-62 — `GET /audit-log` rows show `actorName`/`actorEmail` instead of a bare id. `User`
   * and `Driver` are looked up in two batched `findMany`s (never N+1 per row); `SYSTEM` actors
   * (API keys, TZ §18) have no such row and are left unresolved by the caller.
   */
  async findActorNames(
    userIds: string[],
    driverIds: string[],
  ): Promise<Map<string, { name: string; email: string | null }>> {
    const map = new Map<string, { name: string; email: string | null }>();
    if (userIds.length > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      for (const u of users) map.set(u.id, { name: `${u.firstName} ${u.lastName}`.trim(), email: u.email });
    }
    if (driverIds.length > 0) {
      const drivers = await this.prisma.driver.findMany({
        where: { id: { in: driverIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      });
      for (const d of drivers) map.set(d.id, { name: `${d.firstName} ${d.lastName}`.trim(), email: d.email });
    }
    return map;
  }
}
