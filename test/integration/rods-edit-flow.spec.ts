/**
 * tz.md §9 / 49 CFR §395.30, §395.22(i) — the RODS edit and certification flow against the
 * REAL dev database, where `EldEvent` is append-only (UPDATE/DELETE revoked for the app role).
 *
 * This is the test that proves the design in decisions.md D-019 works end to end: a §395.30
 * edit is applied by APPENDING records, the retired record is still physically present, and
 * the duty timeline every reader rebuilds (including the HOS engine's `recordStatus = 1`
 * filter) shows the corrected picture.
 *
 * `EldEvent` and `AuditLog` rows created here stay — that is what append-only means. The
 * vehicle/driver/device/DailyLog fixtures are cleaned up so `seed-shape.spec.ts` keeps its
 * exact counts.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../src/core/prisma/prisma.service';
import type { EventBusService } from '../../src/core/events/event-bus.service';
import { AuditRepository } from '../../src/modules/audit/audit.repository';
import { IngestRepository } from '../../src/modules/ingest/ingest.repository';
import { LogsRepository } from '../../src/modules/logs/logs.repository';
import { LogsService } from '../../src/modules/logs/logs.service';
import { RodsEventWriter } from '../../src/modules/logs/rods-event-writer';
import { computeChecksum } from '../../src/modules/ingest/checksum';

const prisma = new PrismaClient();
const prismaService = prisma as unknown as PrismaService;
const tag = randomUUID().slice(0, 8);

const ingestRepo = new IngestRepository(prismaService);
const logsRepo = new LogsRepository(prismaService);
const writer = new RodsEventWriter(ingestRepo);
const auditRepo = new AuditRepository(prismaService);
const eventBus = { publish: jest.fn(async () => undefined) } as unknown as EventBusService;
const hosQueue = { add: jest.fn(async () => ({})) };
const alertQueue = { add: jest.fn(async () => ({})) };
const logs = new LogsService(logsRepo, writer, auditRepo, eventBus, hosQueue as never, alertQueue as never);

const carrier = { id: '', type: 'user' as const, permissions: { hosEdit: 'FULL' as const, hosCertifyOnBehalf: 'FULL' as const } };
const DAY = '2026-06-01';
const TZ = 'America/New_York';
const NOW = new Date('2026-06-02T12:00:00Z');

let driverId: string;
let vehicleId: string;
let userId: string;

/** Writes a device-style §395 record straight to the append-only table. */
async function seedEvent(at: string, code: number, sequenceId: number, miles?: number): Promise<bigint> {
  const base = {
    uuid: randomUUID(),
    eventType: 1,
    eventCode: code,
    eventDateTime: new Date(at),
    timezoneOffset: -240,
    recordStatus: 1,
    recordOrigin: 1,
    latitude: null,
    longitude: null,
    rawDeviceOdometerKm: null,
    totalEngineHours: null,
  };
  await prisma.$transaction(async (tx) => {
    await ingestRepo.ensurePartitions(tx, ['2026-06-01']);
    await ingestRepo.insertEvents(tx, [
      {
        ...base,
        driverId,
        vehicleId,
        eventSequenceId: sequenceId,
        totalVehicleMiles: miles ?? null,
        checksum: computeChecksum(base),
      },
    ]);
  });
  const row = await prisma.eldEvent.findFirst({ where: { uuid: base.uuid } });
  return row!.id;
}

beforeAll(async () => {
  const vehicle = await prisma.vehicle.create({
    data: { unitNumber: `RODS-${tag}`, vin: `VIN${tag}${tag}`.slice(0, 17), odometerMi: 1000 },
  });
  vehicleId = vehicle.id;
  const driver = await prisma.driver.create({
    data: {
      username: `rods_${tag}`,
      passwordHash: 'x',
      firstName: 'Rods',
      lastName: 'Test',
      cdlNumber: `CDL${tag}`,
      cdlState: 'KY',
      homeTerminalName: 'Florence',
      homeTerminalTimezone: TZ,
    },
  });
  driverId = driver.id;
  const role = await prisma.role.findFirst();
  const user = await prisma.user.create({
    data: {
      email: `rods_${tag}@example.com`,
      firstName: 'Back',
      lastName: 'Office',
      passwordHash: 'x',
      roleId: role!.id,
    },
  });
  userId = user.id;
  carrier.id = user.id;
}, 30_000);

afterAll(async () => {
  await prisma.dailyLog.deleteMany({ where: { driverId } });
  await prisma.hosViolation.deleteMany({ where: { driverId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.driver.deleteMany({ where: { id: driverId } });
  await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
  await prisma.eventSequenceCounter.deleteMany({
    where: { key: { in: [driverId, `unidentified:${vehicleId}`] } },
  });
  await prisma.$disconnect();
});

describe('§395.30 edit flow on an append-only ledger', () => {
  let onDutyId: bigint;
  let drivingId: bigint;

  beforeAll(async () => {
    // 08:00 ON · 09:00 D · 11:00 OFF, local time (UTC-4 on this date).
    onDutyId = await seedEvent('2026-06-01T12:00:00Z', 4, 1, 1000);
    drivingId = await seedEvent('2026-06-01T13:00:00Z', 3, 2, 1000);
    await seedEvent('2026-06-01T15:00:00Z', 1, 3, 1120);
  }, 30_000);

  it('refuses to restatus a real driving record (§395.30(c)(2))', async () => {
    await expect(
      logs.createEditRequest(
        driverId,
        {
          originalEventId: String(drivingId),
          proposedStatus: 'ON',
          proposedStart: new Date('2026-06-01T13:00:00Z'),
          reason: 'Was loading, not driving',
        },
        carrier,
      ),
    ).rejects.toMatchObject({ code: 'DRIVING_TIME_IMMUTABLE', status: 422 });
  });

  it('stores a proposal that changes nothing until the driver answers', async () => {
    const before = await logs.getDay(driverId, DAY, NOW);
    expect(before.summary.drivingSec).toBe(2 * 3600);
    expect(before.summary.onDutySec).toBe(3600);

    const proposal = await logs.createEditRequest(
      driverId,
      {
        originalEventId: String(onDutyId),
        proposedStatus: 'SB',
        proposedStart: new Date('2026-06-01T12:00:00Z'),
        reason: 'Driver was in the sleeper berth',
      },
      carrier,
    );
    expect(proposal.applied).toBe(false);

    const after = await logs.getDay(driverId, DAY, NOW);
    expect(after.summary.onDutySec).toBe(3600);
    expect(after.summary.sleeperSec).toBe(0);

    const pending = await logs.listEditRequests(driverId, { status: 'PENDING' });
    expect(pending.items.map((item) => item.id)).toContain(proposal.id);

    // Accepting applies it: the old record is retired and the new one is active.
    await logs.acceptEditRequest(proposal.id, { id: driverId, type: 'driver' }, {});

    const applied = await logs.getDay(driverId, DAY, NOW);
    expect(applied.summary.onDutySec).toBe(0);
    expect(applied.summary.sleeperSec).toBe(3600);
    // Driving time is untouched by any of this.
    expect(applied.summary.drivingSec).toBe(2 * 3600);

    // The retired record is still physically in the table — nothing was updated or deleted.
    const originalRow = await prisma.eldEvent.findFirst({ where: { id: onDutyId } });
    expect(originalRow).not.toBeNull();
    expect(originalRow!.recordStatus).toBe(1);
    const marker = await prisma.eldEvent.findFirst({
      where: { supersedesId: onDutyId, recordStatus: 2 },
    });
    expect(marker).not.toBeNull();

    const audit = await prisma.auditLog.findMany({
      where: { objectType: 'EldEvent', action: { in: ['LOG_EDIT_REQUESTED', 'LOG_EDIT_ACCEPTED'] }, objectId: proposal.id },
    });
    expect(audit).toHaveLength(2);
  }, 30_000);

  it('certifies the day, then invalidates it again after a driver self-edit (§395.22(i))', async () => {
    const certified = await logs.certify({ dates: [DAY] }, { id: driverId, type: 'driver' });
    expect(certified.days[0]).toMatchObject({ eventCode: 1, certificationCount: 1 });

    const certificationEvent = await prisma.eldEvent.findFirst({
      where: { driverId, eventType: 4 },
      orderBy: { eventDateTime: 'desc' },
    });
    expect(certificationEvent!.eventCode).toBe(1);
    expect(certificationEvent!.comment).toBe(`certifiedDate=${DAY}`);

    await logs.createLogEntry(
      driverId,
      {
        status: 'ON',
        startAt: new Date('2026-06-01T16:00:00Z'),
        endAt: new Date('2026-06-01T17:00:00Z'),
        annotation: 'Fuelling, forgotten at the time',
      },
      { id: driverId, type: 'driver' },
    );

    const log = await prisma.dailyLog.findUnique({
      where: { driverId_logDate: { driverId, logDate: new Date(`${DAY}T00:00:00.000Z`) } },
    });
    expect(log!.certified).toBe(false);
    expect(log!.hasEdits).toBe(true);

    const day = await logs.getDay(driverId, DAY, NOW);
    expect(day.summary.onDutySec).toBe(3600);
    expect(day.certification.recertificationRequired).toBe(true);

    // Re-certifying the same day walks the Appendix A event code to 2.
    const again = await logs.certify({ dates: [DAY] }, { id: driverId, type: 'driver' });
    expect(again.days[0]).toMatchObject({ eventCode: 2, certificationCount: 2 });
  }, 30_000);
});
