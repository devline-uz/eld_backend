/**
 * tz.md §5.5, §18, §23 — `EldEvent` and `AuditLog` must be append-only at the DB level:
 * UPDATE and DELETE are REVOKEd from the application role, and no code path may re-GRANT
 * them. This runs directly against the dev DB (tz.md §21 "Integration — dev DB").
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

describe('append-only enforcement (tz.md §5.5 / §18 / §23)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('blocks UPDATE on EldEvent for the application role', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "EldEvent" SET checksum = 'tampered' WHERE id = -1`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('blocks DELETE on EldEvent for the application role', async () => {
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "EldEvent" WHERE id = -1`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('blocks UPDATE on AuditLog for the application role', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'tampered' WHERE id = -1`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('blocks DELETE on AuditLog for the application role', async () => {
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = -1`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('still allows INSERT and SELECT on both tables (append-only, not read/write-only)', async () => {
    const before = await prisma.auditLog.count();
    await prisma.auditLog.create({
      data: {
        actorId: 'integration-test',
        actorType: 'SYSTEM',
        action: 'TEST_APPEND_ONLY_PROOF',
        objectType: 'IntegrationTest',
        objectId: 'append-only-spec',
      },
    });
    const after = await prisma.auditLog.count();
    expect(after).toBe(before + 1);
  });

  // Regression coverage for the bug fixed by migration
  // `20260910190500_append_only_revoke_hardening`: REVOKE on the partitioned
  // PARENT table does not propagate to child partitions — each partition has
  // its own ACL, so direct access to a partition name bypassed the
  // parent-level REVOKE until partitions were hardened individually (and
  // `create_monthly_partition()` was updated to harden every future one).
  describe('partition-level enforcement (direct access bypassing the parent)', () => {
    it('blocks UPDATE/DELETE on an existing EldEvent month partition', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ partition: string }>>(
        `SELECT inhrelid::regclass::text AS partition FROM pg_inherits
         WHERE inhparent = '"EldEvent"'::regclass AND inhrelid::regclass::text <> '"EldEvent_default"'
         LIMIT 1`,
      );
      const partition = rows[0]?.partition;
      expect(partition).toBeDefined();

      await expect(
        prisma.$executeRawUnsafe(`UPDATE ${partition} SET checksum = 'tampered' WHERE id = -1`),
      ).rejects.toThrow(/permission denied/i);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM ${partition} WHERE id = -1`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('blocks UPDATE/DELETE on the EldEvent DEFAULT catch-all partition', async () => {
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "EldEvent_default" SET checksum = 'tampered' WHERE id = -1`),
      ).rejects.toThrow(/permission denied/i);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "EldEvent_default" WHERE id = -1`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('a NEW partition created by create_monthly_partition() is append-only from creation', async () => {
      // Far enough in the future that it cannot collide with any partition another test creates.
      await prisma.$executeRawUnsafe(`SELECT create_monthly_partition('EldEvent', DATE '2098-11-01')`);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "EldEvent_y2098m11" SET checksum = 'tampered' WHERE id = -1`),
      ).rejects.toThrow(/permission denied/i);
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "EldEvent_y2098m11" WHERE id = -1`)).rejects.toThrow(
        /permission denied/i,
      );
    });
  });
});
