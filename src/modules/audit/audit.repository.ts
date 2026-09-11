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
}
