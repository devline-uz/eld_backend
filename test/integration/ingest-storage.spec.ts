/**
 * tz.md §5.5 / §7.3 rules 6 & 8 — the ingest storage layer against the real dev DB:
 * sequence allocation under the advisory lock (assigned once, monotonic, wrapping at 65535),
 * on-demand monthly partition creation for LATE events (§7.3 rule 3 — up to 30 days of device
 * memory), and the B-009 fix to `EldEvent`'s foreign keys.
 *
 * `EldEvent` rows created here stay (append-only, by design). Their vehicle/driver/device
 * fixtures ARE cleaned up in `afterAll` — which is only possible because B-009's fix removed
 * `EldEvent`'s foreign keys; that cleanup keeps `seed-shape.spec.ts`'s fleet counts intact.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { IngestRepository } from '../../src/modules/ingest/ingest.repository';
import type { PrismaService } from '../../src/core/prisma/prisma.service';

const prisma = new PrismaClient();
const repo = new IngestRepository(prisma as unknown as PrismaService);
const tag = randomUUID().slice(0, 8);

let vehicleId: string;
let driverId: string;
let deviceId: string;

beforeAll(async () => {
  const vehicle = await prisma.vehicle.create({
    data: { unitNumber: `IT-${tag}`, vin: `VIN${tag}${tag}`.slice(0, 17), odometerMi: 1000 },
  });
  vehicleId = vehicle.id;
  const driver = await prisma.driver.create({
    data: {
      username: `it_${tag}`,
      passwordHash: 'x',
      firstName: 'Ingest',
      lastName: 'Test',
      cdlNumber: `CDL${tag}`,
      cdlState: 'OH',
      homeTerminalName: 'Columbus',
    },
  });
  driverId = driver.id;
  const device = await prisma.device.create({
    data: { serial: `PT30_IT_${tag}`, model: 'PT30', vehicleId },
  });
  deviceId = device.id;
});

afterAll(async () => {
  await prisma.device.deleteMany({ where: { serial: { startsWith: `PT30_IT_` , contains: tag } } });
  await prisma.driver.deleteMany({ where: { username: `it_${tag}` } });
  await prisma.vehicle.deleteMany({ where: { unitNumber: `IT-${tag}` } });
  await prisma.eventSequenceCounter.deleteMany({
    where: { key: { in: [driverId, `unidentified:${vehicleId}`, `race_${tag}`] } },
  });
  await prisma.$disconnect();
});

describe('eventSequenceId allocation (tz.md §5.5, §7.3 rule 8)', () => {
  it('hands out consecutive numbers starting at 1 and continues across batches', async () => {
    const first = await prisma.$transaction((tx) => repo.allocateSequenceIds(tx, driverId, 3));
    expect(first).toEqual([1, 2, 3]);
    const second = await prisma.$transaction((tx) => repo.allocateSequenceIds(tx, driverId, 2));
    expect(second).toEqual([4, 5]);
  });

  it('wraps 65535 → 1 (Appendix A range)', async () => {
    const key = `unidentified:${vehicleId}`;
    await prisma.eventSequenceCounter.upsert({
      where: { key },
      create: { key, lastSequenceId: 65_534 },
      update: { lastSequenceId: 65_534 },
    });
    const ids = await prisma.$transaction((tx) => repo.allocateSequenceIds(tx, key, 3));
    expect(ids).toEqual([65_535, 1, 2]);
  });

  it('serializes concurrent allocations for the same driver — no number is ever reused', async () => {
    const key = `race_${tag}`;
    // maxWait is raised too: every batch waits on the same advisory lock by design, and the
    // suite may share the connection pool with the e2e app when the full `npm test` runs.
    const batches = await Promise.all(
      Array.from({ length: 4 }, () =>
        prisma.$transaction((tx) => repo.allocateSequenceIds(tx, key, 4), {
          timeout: 30_000,
          maxWait: 30_000,
        }),
      ),
    );
    const all = batches.flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
});

describe('partitioned storage for late events (tz.md §5.5)', () => {
  it('creates the month partition on demand and routes the row into it', async () => {
    const late = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000); // well outside the seeded range
    const month = `${late.getUTCFullYear()}-${String(late.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const uuid = randomUUID();

    await prisma.$transaction(async (tx) => {
      await repo.ensurePartitions(tx, [month]);
      await repo.insertEvents(tx, [
        {
          uuid,
          driverId,
          vehicleId,
          deviceId,
          eventType: 1,
          eventCode: 4,
          eventSequenceId: 10_001,
          eventDateTime: late,
          timezoneOffset: -240,
          recordOrigin: 1,
          checksum: 'itchecksum000001',
        },
      ]);
    });

    const rows = await prisma.$queryRawUnsafe<Array<{ partition: string }>>(
      `SELECT tableoid::regclass::text AS partition FROM "EldEvent" WHERE uuid = $1`,
      uuid,
    );
    expect(rows[0].partition).toContain(
      `_y${late.getUTCFullYear()}m${String(late.getUTCMonth() + 1).padStart(2, '0')}`,
    );
  });

  it('is idempotent by uuid — a replayed batch inserts nothing new (§7.3 rule 1)', async () => {
    const uuid = randomUUID();
    const at = new Date();
    const row = {
      uuid,
      driverId,
      vehicleId,
      deviceId,
      eventType: 1,
      eventCode: 3,
      eventSequenceId: 10_002,
      eventDateTime: at,
      timezoneOffset: -240,
      recordOrigin: 1,
      checksum: 'itchecksum000002',
    };
    const inserted = await prisma.$transaction((tx) => repo.insertEvents(tx, [row]));
    expect(inserted).toBe(1);

    const existing = await prisma.$transaction((tx) => repo.findExistingUuids(tx, [uuid]));
    expect(existing.has(uuid)).toBe(true);

    const replay = await prisma.$transaction((tx) =>
      repo.insertEvents(tx, [{ ...row, eventSequenceId: 10_003 }]),
    );
    expect(replay).toBe(0);
  });
});

describe('B-009 — `EldEvent` carries no foreign keys (append-only tables cannot)', () => {
  it('hard-deletes a device that HAS ELD events, and the events keep the historical id', async () => {
    const serial = `PT30_IT_DEL_${tag}`;
    const device = await prisma.device.create({ data: { serial, model: 'PT30' } });
    const uuid = randomUUID();
    await prisma.$transaction((tx) =>
      repo.insertEvents(tx, [
        {
          uuid,
          driverId,
          vehicleId,
          deviceId: device.id,
          eventType: 6,
          eventCode: 1,
          eventSequenceId: 10_004,
          eventDateTime: new Date(),
          timezoneOffset: -240,
          recordOrigin: 1,
          checksum: 'itchecksum000003',
        },
      ]),
    );

    await expect(prisma.device.delete({ where: { id: device.id } })).resolves.toMatchObject({
      id: device.id,
    });
    const kept = await prisma.eldEvent.findFirst({ where: { uuid }, select: { deviceId: true } });
    expect(kept?.deviceId).toBe(device.id);
  });

  it('has no foreign key constraints left on EldEvent', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"EldEvent"'::regclass AND contype = 'f'`,
    );
    expect(rows).toEqual([]);
  });

  it('still refuses UPDATE on EldEvent — append-only is intact', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "EldEvent" SET checksum = 'tampered' WHERE id = -1`),
    ).rejects.toThrow(/permission denied/i);
  });
});
