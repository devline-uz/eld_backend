/**
 * tz.md §10 / 49 CFR §395 Appendix A — end-to-end eRODS generation against the REAL dev DB.
 *
 * Proves the §23 checklist line "Output fayl formati Appendix A ga mos (TEST rejimida ham)":
 * real §395 records are written to the append-only `EldEvent` table, the transfer service
 * assembles and stores the output file, and the INDEPENDENT Appendix A validator re-parses
 * the stored bytes and finds no issues — with `erodsMode = TEST`.
 *
 * `EldEvent`/`AuditLog` rows created here stay (that is what append-only means). The
 * driver/vehicle/DailyLog/DataTransfer fixtures are cleaned up so `seed-shape.spec.ts` keeps
 * its exact counts.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../src/core/prisma/prisma.service';
import type { StoragePort } from '../../src/core/storage/storage.port';
import { AuditRepository } from '../../src/modules/audit/audit.repository';
import { IngestRepository } from '../../src/modules/ingest/ingest.repository';
import { computeChecksum } from '../../src/modules/ingest/checksum';
import { FmcsaEncryptionService } from '../../src/modules/transfers/fmcsa-encryption.service';
import { FmcsaTransferService } from '../../src/modules/transfers/fmcsa-transfer.service';
import { LoggingMailTransport } from '../../src/modules/transfers/logging-mail.transport';
import { TransfersRepository } from '../../src/modules/transfers/transfers.repository';
import { TransfersService } from '../../src/modules/transfers/transfers.service';
import { validateOutputFile } from '../../src/modules/transfers/validator';
import { SEGMENT_TITLES } from '../../src/modules/transfers/segments';
import { licenseDigitSum, licenseLastTwoDigits } from '../../src/modules/transfers/filename';

const prisma = new PrismaClient();
const prismaService = prisma as unknown as PrismaService;
const tag = randomUUID().slice(0, 8);

/** In-memory StoragePort: the integration boundary under test is Postgres, not MinIO. */
const objects = new Map<string, Buffer>();
const storage: StoragePort = {
  async put(key, body) {
    objects.set(key, Buffer.from(body));
    return key;
  },
  async get(key) {
    const body = objects.get(key);
    if (!body) throw new Error(`missing object ${key}`);
    return body;
  },
  async delete(key) {
    objects.delete(key);
  },
  async exists(key) {
    return objects.has(key);
  },
  async presignPut() {
    return 'https://example.invalid';
  },
  async presignGet() {
    return 'https://example.invalid';
  },
};

const config = { get: () => undefined } as never;
const ingestRepo = new IngestRepository(prismaService);
const transfersRepo = new TransfersRepository(prismaService);
const auditRepo = new AuditRepository(prismaService);
const fmcsa = new FmcsaTransferService(config, new FmcsaEncryptionService(config), new LoggingMailTransport());
const queue = { add: jest.fn(async () => ({})) };
const service = new TransfersService(transfersRepo, auditRepo, fmcsa, storage, queue as never);

const ACTOR = { id: '', type: 'user' as const, permissions: { reportsTransfer: 'FULL' as const } };
const RANGE_START = new Date('2026-06-01T00:00:00Z');
const RANGE_END = new Date('2026-06-08T00:00:00Z');

let driverId: string;
let vehicleId: string;
let userId: string;
let sequence = 1;
let cdlNumber: string;

async function seedEvent(at: string, fields: Record<string, unknown>): Promise<void> {
  const base = {
    uuid: randomUUID(),
    eventType: 1,
    eventCode: 3,
    eventDateTime: new Date(at),
    timezoneOffset: -240,
    recordStatus: 1,
    recordOrigin: 1,
    latitude: 41.318511,
    longitude: -72.928932,
    rawDeviceOdometerKm: null,
    totalEngineHours: 4321.4,
    ...fields,
  };
  await prisma.$transaction(async (tx) => {
    await ingestRepo.ensurePartitions(tx, [at.slice(0, 10)]);
    await ingestRepo.insertEvents(tx, [
      {
        ...base,
        driverId: (fields.driverId as string | null) === null ? null : driverId,
        vehicleId,
        eventSequenceId: sequence++,
        totalVehicleMiles: 120_000 + sequence,
        checksum: computeChecksum(base),
      },
    ]);
  });
}

beforeAll(async () => {
  await prisma.carrier.upsert({
    where: { id: 'carrier' },
    create: { id: 'carrier', name: 'Carrier', dotNumber: '' },
    update: {},
  });
  // §10.1 — the file must be generated fully and correctly in TEST mode.
  await prisma.carrier.update({ where: { id: 'carrier' }, data: { erodsMode: 'TEST', eldIdentifier: 'OBK001' } });

  const vehicle = await prisma.vehicle.create({
    data: { unitNumber: `ERODS-${tag}`, vin: `VIN${tag}${tag}`.slice(0, 17), odometerMi: 120_000 },
  });
  vehicleId = vehicle.id;

  const driver = await prisma.driver.create({
    data: {
      username: `erods_${tag}`,
      passwordHash: 'x',
      firstName: 'John',
      lastName: "O'Brien-Smith",
      cdlNumber: `CDL${tag}`,
      cdlState: 'CT',
      homeTerminalName: 'New Haven',
      homeTerminalTimezone: 'America/New_York',
    },
  });
  driverId = driver.id;
  cdlNumber = driver.cdlNumber;

  // An existing back-office user (seeded): it plays the fleet manager who made the §395.30
  // edit. Reused rather than created so the cleanup below cannot fight other FK owners.
  const user = await prisma.user.findFirstOrThrow();
  userId = user.id;
  ACTOR.id = user.id;

  // A realistic 8-day RODS set: duty statuses, a driving record, an intermediate log,
  // a certification, a malfunction, a superseded record and an unidentified driving record.
  await seedEvent('2026-06-01T10:00:00Z', { eventCode: 1 });
  await seedEvent('2026-06-01T12:00:00Z', { eventCode: 4, annotation: 'Pre-trip inspection done' });
  await seedEvent('2026-06-01T12:30:00Z', { eventCode: 3 });
  await seedEvent('2026-06-01T20:00:00Z', { eventType: 3, eventCode: 1, locationPrecisionMi: 10 });
  await seedEvent('2026-06-02T14:00:00Z', { eventType: 2, eventCode: 2, latitude: null, longitude: null });
  await seedEvent('2026-06-02T23:30:00Z', { eventType: 4, eventCode: 1 });
  await seedEvent('2026-06-03T09:00:00Z', { eventType: 7, eventCode: 1, malfunctionCode: 'P' });
  await seedEvent('2026-06-04T11:00:00Z', { eventCode: 4, recordStatus: 2 });
  await seedEvent('2026-06-04T11:00:00Z', {
    eventCode: 4,
    recordOrigin: 2,
    editedById: userId,
    editorType: 'USER',
    annotation: 'Driver corrected the status',
  });
  await seedEvent('2026-06-05T02:00:00Z', { driverId: null, recordOrigin: 4 });

  await prisma.dailyLog.create({
    data: {
      driverId,
      logDate: new Date('2026-06-01T00:00:00Z'),
      timezone: 'America/New_York',
      certified: true,
      certificationCount: 1,
    },
  });
});

afterAll(async () => {
  await prisma.dataTransfer.deleteMany({ where: { driverId } });
  await prisma.dailyLog.deleteMany({ where: { driverId } });
  await prisma.driver.deleteMany({ where: { id: driverId } });
  await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
  await prisma.$disconnect();
});

describe('eRODS output file from real RODS data (TEST mode)', () => {
  it('generates an Appendix A-conformant file and stores it', async () => {
    const view = await service.create(
      {
        driverId,
        method: 'WEB_SERVICES',
        rangeStart: RANGE_START,
        rangeEnd: RANGE_END,
        outputFileComment: 'Integration check',
      } as never,
      ACTOR,
    );

    expect(view.transfer.erodsMode).toBe('TEST');
    expect(view.transfer.status).toBe('QUEUED');
    // Appendix A 4.8.2.2: OBRIE (letters only) + last 2 licence digits + licence digit sum
    // + creation MMDDYY (home terminal) + '-' + 9-digit per-day sequence - 1. 25 chars + .csv.
    const fileName = view.transfer.fileName;
    expect(fileName).toMatch(/^OBRIE[0-9]{4}[0-9]{6}-[0-9]{9}\.csv$/);
    expect(fileName.slice(5, 9)).toBe(licenseLastTwoDigits(cdlNumber) + licenseDigitSum(cdlNumber));
    expect(fileName).toHaveLength(29);
    expect(view.warnings.map((w) => w.code)).toContain('ERODS_TEST_MODE');

    const stored = objects.get(view.transfer.fileKey)!;
    const result = validateOutputFile(stored.toString('utf8'));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);

    // Every segment carries the records we seeded.
    // 4.8.2.1.1: the header is 7 fixed lines.
    expect(result.counts.header).toBe(7);
    expect(result.counts.events).toBeGreaterThanOrEqual(7);
    expect(result.counts.certifications).toBe(1);
    expect(result.counts.malfunctions).toBe(1);
    // Unidentified driving is ELD-wide, not per driver (Appendix A "Unidentified Driver
    // Profile Records"), and `EldEvent` is append-only — so earlier runs' records are
    // legitimately still in the window. At least our own one must be there.
    expect(result.counts.unidentified).toBeGreaterThanOrEqual(1);
    expect(result.counts.annotations).toBeGreaterThanOrEqual(2);
    expect(result.counts.cmvs).toBeGreaterThanOrEqual(1);
    // 4.8.2.1.2: driver + the fleet manager who made the §395.30 edit + the always-listed
    // unidentified driver profile (7.13).
    expect(result.counts.users).toBe(3);
    // 4.8.2.1.4: the event list holds event types 1, 2, 3 only (certification / malfunction
    // records live in their own segments).
    const csvText = stored.toString('utf8');
    const listLines = (from: string, to: string) =>
      csvText.split(from + '\r\n')[1].split(to)[0].split('\r\n').filter(Boolean);
    expect(
      listLines(SEGMENT_TITLES.events, SEGMENT_TITLES.annotations).every((l) => ['1', '2', '3'].includes(l.split(',')[3])),
    ).toBe(true);
    // Header line 7: Registration ID, ELD Identifier (7.15 — 6 chars), Authentication, Comment.
    const headerLines = listLines(SEGMENT_TITLES.header, SEGMENT_TITLES.users);
    expect(headerLines).toHaveLength(7);
    expect(headerLines[6].split(',')[1]).toBe('OBK001');
    // 4.8.2.1.11 / 7.27: the file data check value is 4 hex characters.
    expect(csvText.split(SEGMENT_TITLES.endOfFile + '\r\n')[1].trim()).toMatch(/^[0-9A-F]{4}$/);

    const unidentifiedLines = stored
      .toString('utf8')
      .split(SEGMENT_TITLES.unidentified + '\r\n')[1]
      .split(SEGMENT_TITLES.endOfFile)[0]
      .split('\r\n')
      .filter(Boolean);
    expect(unidentifiedLines.every((l) => l.split(',')[2] === '4')).toBe(true);
  });

  it('keeps the superseded record (recordStatus 2) in the file — nothing is deleted', async () => {
    const view = await service.create(
      {
        driverId,
        method: 'WEB_SERVICES',
        rangeStart: RANGE_START,
        rangeEnd: RANGE_END,
        outputFileComment: 'Audit trail check',
      } as never,
      ACTOR,
    );
    const csv = objects.get(view.transfer.fileKey)!.toString('utf8');
    const eventLines = csv
      .split(SEGMENT_TITLES.events + '\r\n')[1]
      .split(SEGMENT_TITLES.annotations)[0]
      .split('\r\n')
      .filter(Boolean);
    expect(eventLines.some((l) => l.split(',')[1] === '2')).toBe(true);
    expect(eventLines.some((l) => l.split(',')[2] === '2')).toBe(true);
  });

  it('increments the Appendix A 4.8.2.2(f) file sequence for the next file of the same day', async () => {
    const before = await transfersRepo.listTransfers({ driverId }, 1, 50);
    const view = await service.create(
      {
        driverId,
        method: 'WEB_SERVICES',
        rangeStart: RANGE_START,
        rangeEnd: RANGE_END,
        outputFileComment: 'Sequence check',
      } as never,
      ACTOR,
    );
    // 9-digit suffix = per-driver per-day sequence - 1 (first file 000000000, D-120).
    const suffix = view.transfer.fileName.slice(-13, -4);
    expect(suffix).toMatch(/^[0-9]{9}$/);
    expect(Number(suffix)).toBe(before.total);
  });

  it('re-validates and serves the stored bytes through the download path', async () => {
    const view = await service.create(
      {
        driverId,
        method: 'WEB_SERVICES',
        rangeStart: RANGE_START,
        rangeEnd: RANGE_END,
        outputFileComment: 'Download check',
      } as never,
      ACTOR,
    );
    const downloaded = await service.download(view.transfer.id, ACTOR);
    expect(downloaded.fileName).toBe(view.transfer.fileName);
    expect(validateOutputFile(downloaded.csv).valid).toBe(true);

    const audit = await prisma.auditLog.findMany({
      where: { objectType: 'DataTransfer', objectId: view.transfer.id },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['ERODS_TRANSFER_REQUESTED', 'ERODS_TRANSFER_DOWNLOADED']);
  });

  it('regenerating the same range produces identical event sequence ids (§7.3)', async () => {
    const first = await service.create(
      { driverId, method: 'WEB_SERVICES', rangeStart: RANGE_START, rangeEnd: RANGE_END, outputFileComment: 'A' } as never,
      ACTOR,
    );
    const second = await service.create(
      { driverId, method: 'WEB_SERVICES', rangeStart: RANGE_START, rangeEnd: RANGE_END, outputFileComment: 'A' } as never,
      ACTOR,
    );
    const seqOf = (key: string) =>
      objects
        .get(key)!
        .toString('utf8')
        .split(SEGMENT_TITLES.events + '\r\n')[1]
        .split(SEGMENT_TITLES.annotations)[0]
        .split('\r\n')
        .filter(Boolean)
        .map((l) => l.split(',')[0]);
    expect(seqOf(second.transfer.fileKey)).toEqual(seqOf(first.transfer.fileKey));
  });

  it('rejects a 9-day range with RANGE_TOO_LARGE', async () => {
    await expect(
      service.create(
        {
          driverId,
          method: 'WEB_SERVICES',
          rangeStart: new Date('2026-05-31T00:00:00Z'),
          rangeEnd: RANGE_END,
          outputFileComment: 'Too wide',
        } as never,
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' });
  });
});
