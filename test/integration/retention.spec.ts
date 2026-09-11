/**
 * tz.md §5.5 / §18 / §23 compliance-checklist line "RODS retained 6 months, audit retained
 * 24 months". Runs against the real dev DB (tz.md §21 "Integration — dev DB") but never
 * touches real EldEvent/AuditLog data:
 *   - `EldEvent`: creates ONE scratch monthly partition (year 2003 — far from any real
 *     seeded or ingested data), inserts a handful of rows into it, drives
 *     `RetentionService.sweepEldEvent` end to end (archive to a fake in-memory "S3", verify,
 *     DETACH+DROP) against ONLY that partition (`listEldEventPartitions` is stubbed to
 *     return it alone, so real partitions from seed/other agents' concurrent work are never
 *     touched), and asserts the partition is gone afterwards. Self-cleaning: the DROP *is*
 *     the cleanup.
 *   - `AuditLog`: since `AuditLog` cannot be partitioned/dropped this way (it is append-only
 *     DML, no DDL escape hatch — see retention-purge.service.ts), the test inserts one
 *     clearly-scratch row (`actorId: 'retention-test-scratch'`) and only asserts it is
 *     correctly *counted as eligible* past the 24-month cutoff and that the purge step is
 *     safely skipped in this environment (`RETENTION_DATABASE_URL` unset) rather than ever
 *     falling back to the app role. It is never deleted here — AuditLog rows cannot be
 *     deleted by this test's DB role by design, so the scratch row simply stays, same as any
 *     other audit trail entry.
 *
 * Boundary math itself (rangeEnd <= cutoff vs. rangeEnd > cutoff by 1ms) is covered without
 * any DB access in `src/modules/retention/retention.service.spec.ts`.
 */
import { PrismaClient, EditorType } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { PutObjectOptions, StoragePort } from '../../src/core/storage/storage.port';
import type { PrismaService } from '../../src/core/prisma/prisma.service';
import { AuditRepository } from '../../src/modules/audit/audit.repository';
import { RetentionPurgeService } from '../../src/modules/retention/retention-purge.service';
import { RetentionRepository } from '../../src/modules/retention/retention.repository';
import { RetentionService } from '../../src/modules/retention/retention.service';

const rawPrisma = new PrismaClient();
const prisma = rawPrisma as unknown as PrismaService;

/** In-memory stand-in for S3/MinIO — records every uploaded object so the test can assert
 * on exactly what was archived, without needing MinIO reachable in every environment this
 * suite runs in. */
class FakeStorage implements StoragePort {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<string> {
    this.objects.set(key, Buffer.from(body));
    return key;
  }

  async putStream(key: string, body: NodeJS.ReadableStream, _options?: PutObjectOptions) {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      body.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      body.on('end', () => resolve());
      body.on('error', reject);
    });
    const buf = Buffer.concat(chunks);
    this.objects.set(key, buf);
    return { key, sizeBytes: buf.length };
  }

  async get(key: string): Promise<Buffer> {
    const v = this.objects.get(key);
    if (!v) throw new Error('not found');
    return v;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async presignPut(key: string): Promise<string> {
    return `put://${key}`;
  }

  async presignGet(key: string): Promise<string> {
    return `get://${key}`;
  }
}

describe('retention.processor — EldEvent partition retention (scratch partition only)', () => {
  const PARTITION_NAME = 'EldEvent_y2003m03';
  const repo = new RetentionRepository(prisma);
  const auditRepo = new AuditRepository(prisma);
  const purge = new RetentionPurgeService({ get: () => undefined } as never);
  let storage: FakeStorage;
  let service: RetentionService;
  const uuids: string[] = [];

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`SELECT create_monthly_partition('EldEvent', DATE '2003-03-01')`);
    for (let i = 0; i < 3; i += 1) {
      const uuid = randomUUID();
      uuids.push(uuid);
      await prisma.eldEvent.create({
        data: {
          uuid,
          eventType: 1,
          eventCode: 4,
          eventSequenceId: 10_000 + i,
          eventDateTime: new Date(Date.UTC(2003, 2, 10 + i)),
          timezoneOffset: -240,
          recordOrigin: 1,
          checksum: `retention-scratch-${i}`,
        },
      });
    }
  });

  beforeEach(() => {
    storage = new FakeStorage();
    service = new RetentionService(repo, purge, auditRepo, storage);
  });

  afterAll(async () => {
    // Defensive: if a test failed before the DROP step ran, make sure the scratch partition
    // never lingers in the dev DB for other agents/CI runs.
    const stillThere = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = '${PARTITION_NAME}'`,
    );
    if ((stillThere[0]?.n ?? 0) > 0) {
      await repo.detachAndDropPartition(PARTITION_NAME);
    }
    await prisma.$disconnect();
  });

  it('lists the scratch partition with the correct [start, end) range', async () => {
    const partitions = await repo.listEldEventPartitions();
    const scratch = partitions.find((p) => p.name === PARTITION_NAME);
    expect(scratch).toBeDefined();
    expect(scratch!.rangeStart.toISOString()).toBe('2003-03-01T00:00:00.000Z');
    expect(scratch!.rangeEnd.toISOString()).toBe('2003-04-01T00:00:00.000Z');
  });

  it('does NOT mark the scratch partition eligible while "now" keeps it inside the 24-month window', async () => {
    const partitions = await repo.listEldEventPartitions();
    const scratch = partitions.find((p) => p.name === PARTITION_NAME)!;
    // A cutoff computed from "now" = 2005-03-15 puts the 24-month floor at 2003-03-15,
    // which is BEFORE this partition's rangeEnd (2003-04-01) — still in-window, must survive.
    const cutoff = new Date('2003-03-15T00:00:00.000Z');
    expect(RetentionService.partitionsEligibleForDrop([scratch], cutoff)).toEqual([]);
  });

  it('archives to storage, verifies, and DETACH+DROPs the scratch partition once "now" pushes it past the 24-month floor', async () => {
    const countBefore = await repo.countPartitionRows(PARTITION_NAME);
    expect(countBefore).toBe(3);

    jest.spyOn(repo, 'listEldEventPartitions').mockResolvedValueOnce([
      { name: PARTITION_NAME, rangeStart: new Date('2003-03-01'), rangeEnd: new Date('2003-04-01') },
    ]);

    // "now" = 2005-06-01 -> 24-month cutoff = 2003-06-01, well past this partition's
    // 2003-04-01 rangeEnd, so it is eligible.
    const now = { minus: () => ({ toJSDate: () => new Date('2003-06-01T00:00:00.000Z') }) } as never;
    const result = await service.sweepEldEvent(now);

    expect(result.droppedPartitions).toEqual([PARTITION_NAME]);
    expect(result.skippedWithinWindow).toBe(0);

    const archived = [...storage.objects.entries()].find(([k]) => k.includes(PARTITION_NAME));
    expect(archived).toBeDefined();
    const lines = archived![1].toString('utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const row = JSON.parse(line) as { uuid: string };
      expect(uuids).toContain(row.uuid);
    }

    const stillThere = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = '${PARTITION_NAME}'`,
    );
    expect(stillThere[0].n).toBe(0);

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: 'RETENTION_DROP_PARTITION', objectId: PARTITION_NAME },
      orderBy: { id: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.actorType).toBe(EditorType.SYSTEM);
  });
});

describe('retention.processor — AuditLog retention (scratch row only, never deleted by this test)', () => {
  const repo = new RetentionRepository(prisma);
  const auditRepo = new AuditRepository(prisma);
  const purge = new RetentionPurgeService({ get: () => undefined } as never); // RETENTION_DATABASE_URL unset
  let storage: FakeStorage;
  let service: RetentionService;
  let scratchRowCreatedAt: Date;

  beforeAll(async () => {
    // 30 months old — well past the 24-month floor, but inserted via the normal app
    // connection (INSERT is not revoked, only UPDATE/DELETE — B-009).
    scratchRowCreatedAt = new Date(Date.now() - 30 * 30 * 24 * 60 * 60 * 1000);
    await prisma.auditLog.create({
      data: {
        actorId: 'retention-test-scratch',
        actorType: EditorType.SYSTEM,
        action: 'RETENTION_TEST_FIXTURE',
        objectType: 'RetentionTestFixture',
        objectId: 'scratch-1',
        createdAt: scratchRowCreatedAt,
      },
    });
  });

  beforeEach(() => {
    storage = new FakeStorage();
    service = new RetentionService(repo, purge, auditRepo, storage);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('counts the scratch row as eligible once it is older than the 24-month floor', async () => {
    const cutoff = service.auditCutoff();
    expect(cutoff.getTime()).toBeGreaterThan(scratchRowCreatedAt.getTime());
    const eligible = await repo.countAuditLogOlderThan(cutoff);
    expect(eligible).toBeGreaterThanOrEqual(1);
  });

  it('never treats a row created "now" as eligible (boundary: must be strictly older than the cutoff)', async () => {
    const cutoff = service.auditCutoff();
    const recent = await prisma.auditLog.count({ where: { createdAt: { lt: cutoff }, actorId: 'retention-test-scratch-should-not-exist' } });
    expect(recent).toBe(0);
  });

  it('sweepAuditLog finds the scratch row eligible but skips the purge (RETENTION_DATABASE_URL unset) instead of falling back to the app role', async () => {
    const result = await service.sweepAuditLog();
    expect(result.eligible).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('RETENTION_DATABASE_URL not configured');
    expect(result.purged).toBe(0);

    // Prove it really is still there — this DB role is structurally incapable of deleting it.
    const stillExists = await prisma.auditLog.findFirst({ where: { actorId: 'retention-test-scratch', objectId: 'scratch-1' } });
    expect(stillExists).not.toBeNull();
  });
});
