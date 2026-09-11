import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface EldEventPartition {
  /** Physical child-table name, e.g. `EldEvent_y2026m01`. */
  name: string;
  rangeStart: Date;
  rangeEnd: Date;
}

/**
 * Raw-SQL/DDL access for `retention.processor` (TZ §5.5, §18). Deliberately separate from
 * every other repository: everything here is either read-only introspection (`pg_catalog`),
 * DDL that the owning app role always retains regardless of the DML `REVOKE` (`DETACH
 * PARTITION` / `DROP TABLE` — B-009's REVOKE only strips UPDATE/DELETE, never ownership),
 * or plain `SELECT`s used to build the S3 archive. It never issues `DELETE`/`UPDATE` against
 * `EldEvent` or `AuditLog` — see `RetentionPurgeService` for the one place that does, and
 * why that needs a different DB role entirely.
 */
@Injectable()
export class RetentionRepository {
  private readonly logger = new Logger(RetentionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Lists every real (non-DEFAULT) `EldEvent` child partition with its `[start, end)`
   * range, parsed from `pg_get_expr(relpartbound, oid)`. The catch-all DEFAULT partition
   * has no parseable `FOR VALUES FROM ... TO ...` bound and is always skipped — it must
   * never be auto-dropped by this job. */
  async listEldEventPartitions(): Promise<EldEventPartition[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ name: string; bound: string | null }[]>(
      `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = '"EldEvent"'::regclass
       ORDER BY c.relname`,
    );
    const partitions: EldEventPartition[] = [];
    for (const row of rows) {
      const parsed = this.parseBound(row.bound);
      if (!parsed) {
        this.logger.debug({ name: row.name }, 'Skipping unparseable/DEFAULT EldEvent partition');
        continue;
      }
      partitions.push({ name: row.name, ...parsed });
    }
    return partitions;
  }

  private parseBound(bound: string | null): { rangeStart: Date; rangeEnd: Date } | null {
    if (!bound) return null;
    const m = bound.match(/FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/);
    if (!m) return null;
    return { rangeStart: parseUtcTimestamp(m[1]), rangeEnd: parseUtcTimestamp(m[2]) };
  }

  /** Row count for a single partition, queried directly against the physical child table
   * (never the parent — this is used to cross-check the archive before a DROP). */
  async countPartitionRows(partitionName: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM ${quoteIdent(partitionName)}`,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  /** Streams every row of a partition in ascending-id batches, for the archive upload. */
  async *streamPartitionRows(
    partitionName: string,
    batchSize = 2000,
  ): AsyncGenerator<Record<string, unknown>[]> {
    let lastId: bigint | null = null;
    for (;;) {
      const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        lastId === null
          ? `SELECT * FROM ${quoteIdent(partitionName)} ORDER BY id ASC LIMIT ${batchSize}`
          : `SELECT * FROM ${quoteIdent(partitionName)} WHERE id > ${lastId} ORDER BY id ASC LIMIT ${batchSize}`,
      );
      if (rows.length === 0) return;
      yield rows;
      lastId = rows[rows.length - 1].id as bigint;
    }
  }

  /** DDL only — `DETACH PARTITION` then `DROP TABLE`. Always called after the caller has
   * verified the S3 archive; this method itself does not check the cutoff or the archive,
   * both are the service's job (kept here dumb-and-narrow on purpose). */
  async detachAndDropPartition(partitionName: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE "EldEvent" DETACH PARTITION ${quoteIdent(partitionName)}`,
    );
    await this.prisma.$executeRawUnsafe(`DROP TABLE ${quoteIdent(partitionName)}`);
  }

  async countAuditLogOlderThan(cutoff: Date): Promise<number> {
    return this.prisma.auditLog.count({ where: { createdAt: { lt: cutoff } } });
  }

  async *streamAuditLogOlderThan(
    cutoff: Date,
    batchSize = 2000,
  ): AsyncGenerator<Record<string, unknown>[]> {
    let cursorId: bigint | null = null;
    for (;;) {
      const where: Prisma.AuditLogWhereInput = { createdAt: { lt: cutoff } };
      if (cursorId !== null) where.id = { gt: cursorId };
      const rows: Prisma.AuditLogGetPayload<Record<string, never>>[] = await this.prisma.auditLog.findMany({
        where,
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (rows.length === 0) return;
      yield rows;
      cursorId = rows[rows.length - 1].id;
    }
  }
}

/**
 * `pg_get_expr(relpartbound, oid)` on `EldEvent` (a `TIMESTAMP(3)` — no time zone — column,
 * tz.md §5.5 deviation #1) renders bounds as e.g. `'2003-03-01 00:00:00'`: a space, not `T`,
 * and no zone suffix. `new Date(...)` on that exact shape is NOT parsed per the ISO-8601
 * fast path (which requires `T`/date-only) — V8 falls back to its legacy parser, which reads
 * space-separated `YYYY-MM-DD HH:MM:SS` in the *process's local time zone*, not UTC. Every
 * `eventDateTime` this project ever writes is a UTC instant (checked repo-wide as part of the
 * tasks.md "All timestamps stored in UTC..." compliance line, bugs.md B-036), so the bound
 * text must be interpreted as UTC too — hence the explicit `T`/`Z` splice below instead of a
 * bare `new Date(text)`, which silently depended on `TZ=UTC` in whatever process runs this
 * job (true in this repo's containers, but not guaranteed, and not true in this exact Jest
 * run — this bug reproduced here as an off-by-one-hour partition bound in CET).
 */
function parseUtcTimestamp(text: string): Date {
  const iso = text.trim().replace(' ', 'T');
  return new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
}

/** Defends the interpolated identifiers above: only `pg_class.relname`-shaped names (the
 * partition names this repository itself listed) are ever allowed through, so this can never
 * become a SQL-injection sink even though `$queryRawUnsafe`/`$executeRawUnsafe` can't
 * parameterize identifiers. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to use unsafe identifier as a partition name: ${name}`);
  }
  return `"${name}"`;
}
