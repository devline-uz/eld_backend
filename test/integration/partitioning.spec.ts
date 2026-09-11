/**
 * tz.md §5.5 (EldEvent) / §5.6 (TelemetryPoint) — both tables are monthly-partitioned by
 * time. This proves partition routing actually works: a row inserted with a given
 * `eventDateTime`/`time` physically lands in the matching monthly child table, and that
 * `create_monthly_partition()` (the mechanism `retention.processor` uses to create future
 * partitions ahead of need) produces a usable partition on demand.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

async function partitionOf(table: string, pkWhere: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ partition: string }>>(
    `SELECT tableoid::regclass::text AS partition FROM "${table}" WHERE ${pkWhere} LIMIT 1`,
  );
  return rows[0]?.partition ?? null;
}

describe('monthly partitioning (tz.md §5.5 / §5.6)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('EldEvent is a native partitioned table with monthly children + a DEFAULT catch-all', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ partition: string }>>(
      `SELECT inhrelid::regclass::text AS partition FROM pg_inherits WHERE inhparent = '"EldEvent"'::regclass ORDER BY 1`,
    );
    const names = rows.map((r) => r.partition);
    expect(names.length).toBeGreaterThanOrEqual(6); // at least 6 months hot (tz.md §5.5 table)
    expect(names).toContain('"EldEvent_default"');
  });

  it('routes an inserted EldEvent row into the partition matching its eventDateTime', async () => {
    const uuid = randomUUID();
    const eventDateTime = new Date(); // "this month"
    await prisma.eldEvent.create({
      data: {
        uuid,
        eventType: 1,
        eventCode: 4,
        eventSequenceId: Math.floor(Math.random() * 60000) + 1,
        eventDateTime,
        timezoneOffset: -240,
        recordOrigin: 1,
        checksum: 'test-checksum',
      },
    });

    const expectedSuffix = `_y${eventDateTime.getUTCFullYear()}m${String(eventDateTime.getUTCMonth() + 1).padStart(2, '0')}`;
    const partition = await partitionOf('EldEvent', `uuid = '${uuid}'`);
    expect(partition).not.toBeNull();
    expect(partition).toContain(expectedSuffix);
  });

  it('a row far in the future (no seeded partition) falls back to the DEFAULT partition instead of failing', async () => {
    const uuid = randomUUID();
    const farFuture = new Date(Date.UTC(2099, 0, 15));
    await prisma.eldEvent.create({
      data: {
        uuid,
        eventType: 1,
        eventCode: 4,
        eventSequenceId: Math.floor(Math.random() * 60000) + 1,
        eventDateTime: farFuture,
        timezoneOffset: -240,
        recordOrigin: 1,
        checksum: 'test-checksum',
      },
    });
    const partition = await partitionOf('EldEvent', `uuid = '${uuid}'`);
    expect(partition).toBe('"EldEvent_default"');
  });

  it('create_monthly_partition() creates a usable partition for an arbitrary future month', async () => {
    // A different future month than the "falls back to DEFAULT" test above — attaching a
    // new range partition fails if the DEFAULT partition already holds rows in that range.
    await prisma.$executeRawUnsafe(`SELECT create_monthly_partition('EldEvent', DATE '2099-02-01')`);
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'EldEvent_y2099m02'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('TelemetryPoint is partitioned by time and routes inserts by month', async () => {
    const vehicle = await prisma.vehicle.findFirst();
    if (!vehicle) throw new Error('expected at least one seeded vehicle');
    const time = new Date();
    await prisma.telemetryPoint.create({
      data: { time, vehicleId: vehicle.id, latitude: 39.96, longitude: -83.0 },
    });
    const expectedSuffix = `_y${time.getUTCFullYear()}m${String(time.getUTCMonth() + 1).padStart(2, '0')}`;
    const partition = await partitionOf(
      'TelemetryPoint',
      `"vehicleId" = '${vehicle.id}' AND "time" = '${time.toISOString()}'`,
    );
    expect(partition).not.toBeNull();
    expect(partition).toContain(expectedSuffix);
  });
});
