/**
 * tz.md §15 (tasks.md Phase 8) — reports, against the REAL dev DB (Postgres 55432).
 *
 * Proves, with real data (not mocks of the DB layer):
 *  - the nightly IFTA segment computation derives real per-jurisdiction miles from real
 *    `TelemetryPoint` rows and upserts real `IftaSegment` rows, and never touches a
 *    `locked = true` row (§15 "chorak yopilgach ... qayta hisoblanmaydi");
 *  - the IFTA report aggregates those `IftaSegment`/`FuelPurchase` rows into the standard
 *    IFTA fleet-MPG/taxable-gallons formula;
 *  - the DVIR report reads Phase 7's real `Dvir`/`Defect` rows;
 *  - `ReportProcessor` runs a real `Report` row end to end — QUEUED -> RUNNING -> READY —
 *    storing bytes through the `StoragePort` (in-memory here; the integration boundary
 *    under test is Postgres, matching the convention in erods-output-file.spec.ts);
 *  - `ReportSchedulerProcessor.runTick` advances a real `ReportSchedule` row's `nextRunAt`
 *    and creates a real queued `Report` — the scheduler runs without a manual trigger.
 *
 * All fixtures created here are cleaned up in `afterAll` (never touches `johnsmith`,
 * B-023 / seed-shape.spec.ts).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import type { PrismaService } from '../../src/core/prisma/prisma.service';
import type { StoragePort } from '../../src/core/storage/storage.port';
import { DvirReportGenerator, type DvirReportRow } from '../../src/modules/reports/generators/dvir-report.generator';
import { IftaReportGenerator } from '../../src/modules/reports/generators/ifta-report.generator';
import { IftaSegmentsRepository } from '../../src/modules/reports/ifta/ifta-segments.repository';
import { IftaSegmentsService } from '../../src/modules/reports/ifta/ifta-segments.service';
import { ReportsRepository, ReportSchedulesRepository } from '../../src/modules/reports/reports.repository';
import { ReportsService } from '../../src/modules/reports/reports.service';
import { ReportProcessor } from '../../src/workers/report.processor';
import { ReportSchedulerProcessor } from '../../src/workers/report-scheduler.processor';

const prisma = new PrismaClient();
const prismaService = prisma as unknown as PrismaService;
const tag = randomUUID().slice(0, 8);

const objects = new Map<string, Buffer>();
const storage: StoragePort = {
  async put(key, body) {
    objects.set(key, Buffer.from(body));
    return key;
  },
  async putStream(key, body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    const buf = Buffer.concat(chunks);
    objects.set(key, buf);
    return { key, sizeBytes: buf.length };
  },
  async get(key) {
    const body = objects.get(key);
    if (!body) throw new Error(`no object for ${key}`);
    return body;
  },
  async delete(key) {
    objects.delete(key);
  },
  async exists(key) {
    return objects.has(key);
  },
  async presignPut(key) {
    return `https://minio.local/${key}?put`;
  },
  async presignGet(key) {
    return `https://minio.local/${key}?get`;
  },
};

let vehicleId: string;
let driverId: string;
let userId: string;
const reportIds: string[] = [];
const scheduleIds: string[] = [];
const dvirIds: string[] = [];

beforeAll(async () => {
  await prisma.carrier.upsert({ where: { id: 'carrier' }, create: { id: 'carrier', name: 'Carrier', dotNumber: '' }, update: {} });

  const vehicle = await prisma.vehicle.create({
    data: { unitNumber: `RPT-${tag}`, vin: `VIN${tag}${tag}`.slice(0, 17), odometerMi: 50_000 },
  });
  vehicleId = vehicle.id;

  const driver = await prisma.driver.create({
    data: {
      username: `rpt_${tag}`,
      passwordHash: 'x',
      firstName: 'Reporting',
      lastName: 'Fixture',
      cdlNumber: `CDL${tag}`,
      cdlState: 'OH',
      homeTerminalName: 'Columbus',
      homeTerminalTimezone: 'America/New_York',
    },
  });
  driverId = driver.id;

  const user = await prisma.user.findFirstOrThrow();
  userId = user.id;
});

afterAll(async () => {
  await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
  await prisma.reportSchedule.deleteMany({ where: { id: { in: scheduleIds } } });
  await prisma.defect.deleteMany({ where: { dvirId: { in: dvirIds } } });
  await prisma.dvir.deleteMany({ where: { id: { in: dvirIds } } });
  await prisma.fuelPurchase.deleteMany({ where: { vehicleId } });
  await prisma.iftaSegment.deleteMany({ where: { vehicleId } });
  await prisma.telemetryPoint.deleteMany({ where: { vehicleId } });
  await prisma.dailyLog.deleteMany({ where: { driverId } });
  await prisma.driver.delete({ where: { id: driverId } }).catch(() => undefined);
  await prisma.vehicle.delete({ where: { id: vehicleId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('IFTA nightly segment computation (real TelemetryPoint -> real IftaSegment)', () => {
  it('derives real per-jurisdiction miles and never rewrites a locked segment', async () => {
    const day = DateTime.utc(2026, 7, 20);
    await prisma.telemetryPoint.createMany({
      data: [
        { time: day.set({ hour: 8 }).toJSDate(), vehicleId, driverId, latitude: 39.9612, longitude: -82.9988, odometerMi: 1000 },
        { time: day.set({ hour: 9 }).toJSDate(), vehicleId, driverId, latitude: 38.0406, longitude: -84.5037, odometerMi: 1180 },
      ],
    });

    const repo = new IftaSegmentsRepository(prismaService);
    const service = new IftaSegmentsService(repo);

    const first = await service.computeForDate(day);
    expect(first.segmentsUpserted).toBe(1);

    const segment = await prisma.iftaSegment.findUnique({
      where: { vehicleId_jurisdiction_date: { vehicleId, jurisdiction: 'KY', date: day.toJSDate() } },
    });
    expect(segment).not.toBeNull();
    expect(segment?.distanceMi).toBe(180);

    // Lock it (simulating the quarter having closed), then re-run for the same day: the
    // locked row must be left untouched even though the source telemetry is unchanged.
    await prisma.iftaSegment.update({ where: { id: segment!.id }, data: { locked: true, distanceMi: 999 } });
    const second = await service.computeForDate(day);
    expect(second.segmentsUpserted).toBe(0);
    const reloaded = await prisma.iftaSegment.findUnique({ where: { id: segment!.id } });
    expect(reloaded?.distanceMi).toBe(999); // untouched
  });
});

describe('IftaReportGenerator (real IftaSegment + FuelPurchase aggregation)', () => {
  it('computes the standard IFTA fleet-MPG / taxable-gallons formula from real rows', async () => {
    // Isolate from the other describe blocks in this file, which reuse the same `vehicleId`.
    await prisma.iftaSegment.deleteMany({ where: { vehicleId } });
    await prisma.fuelPurchase.deleteMany({ where: { vehicleId } });
    const quarterDate = new Date('2026-08-01T00:00:00.000Z');
    await prisma.iftaSegment.createMany({
      data: [
        { vehicleId, jurisdiction: 'OH', date: quarterDate, distanceMi: 400 },
        { vehicleId, jurisdiction: 'IN', date: quarterDate, distanceMi: 100 },
      ],
    });
    await prisma.fuelPurchase.create({
      data: { vehicleId, purchasedAt: quarterDate, jurisdiction: 'OH', gallons: 50, pricePerGal: 4, totalUsd: 200 },
    });

    const gen = new IftaReportGenerator(prismaService);
    const rows = await gen.rows({ quarter: '2026-Q3', vehicleId });

    // fleet MPG = 500mi / 50gal = 10
    const oh = rows.find((r) => r.jurisdiction === 'OH')!;
    const inRow = rows.find((r) => r.jurisdiction === 'IN')!;
    expect(oh.fleetMpg).toBe('10.000');
    expect(oh.taxableGallons).toBe('40.000');
    expect(oh.netTaxableGallons).toBe('-10.000'); // 40 taxable - 50 purchased
    expect(inRow.taxableGallons).toBe('10.000');
    expect(inRow.fuelPurchasedGal).toBe('0.00');
  });
});

describe('DvirReportGenerator (real Dvir/Defect rows, Phase 7)', () => {
  it('summarizes real defect counts per DVIR', async () => {
    const dvir = await prisma.dvir.create({
      data: {
        driverId,
        vehicleId,
        type: 'PRE_TRIP',
        submittedAt: new Date('2026-08-05T12:00:00.000Z'),
        odometerMi: 51_000,
        vehicleCondition: 'DEFECTS_FOUND',
        driverSignatureUrl: 'signatures/x.png',
        defects: {
          create: [
            { vehicleId, category: 'Brakes', part: 'TRUCK', severity: 'CRITICAL', description: 'Worn pad', status: 'OPEN' },
            { vehicleId, category: 'Lights', part: 'TRAILER', severity: 'MINOR', description: 'Bulb out', status: 'OPEN' },
          ],
        },
      },
    });
    dvirIds.push(dvir.id);

    const gen = new DvirReportGenerator(prismaService);
    const rows: DvirReportRow[] = [];
    for await (const row of gen.rows({ from: '2026-08-01', to: '2026-08-10', vehicleId })) rows.push(row);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dvirId: dvir.id, defectCount: 2, openDefects: 2, criticalOpenDefects: 1 });
  });
});

describe('ReportProcessor (real Report row, IFTA end to end)', () => {
  it('moves a real Report row QUEUED -> RUNNING -> READY and stores real bytes', async () => {
    await prisma.iftaSegment.deleteMany({ where: { vehicleId } });
    const quarterDate = new Date('2026-08-15T00:00:00.000Z');
    await prisma.iftaSegment.createMany({ data: [{ vehicleId, jurisdiction: 'OH', date: quarterDate, distanceMi: 42 }] });

    const report = await prisma.report.create({
      data: { type: 'IFTA', format: 'CSV', params: { quarter: '2026-Q3', vehicleId }, requestedById: userId },
    });
    reportIds.push(report.id);

    const iftaGen = new IftaReportGenerator(prismaService);
    const processor = new ReportProcessor(
      prismaService,
      storage,
      { publish: jest.fn(async () => undefined) } as never,
      iftaGen,
      undefined as never, // ACTIVITY generator not exercised by this test
      undefined as never, // DVIR generator not exercised by this test
      undefined as never, // FMCSA_PACK generator not exercised by this test
    );

    await processor.process({ id: 'job1', name: 'report.generate', data: { reportId: report.id } } as never);

    const updated = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(updated.status).toBe('READY');
    expect(updated.fileKey).toBe(`reports/${report.id}.csv`);
    expect(updated.rowCount).toBe(1);
    expect(objects.has(`reports/${report.id}.csv`)).toBe(true);
    expect(objects.get(`reports/${report.id}.csv`)!.toString('utf8')).toContain('OH');
  });
});

describe('ReportSchedulerProcessor (real ReportSchedule row — runs without a manual trigger)', () => {
  it('creates a real queued Report and advances nextRunAt for a due schedule', async () => {
    const schedulesRepo = new ReportSchedulesRepository(prismaService);
    const reportsRepo = new ReportsRepository(prismaService);
    const reportsService = new ReportsService(reportsRepo, schedulesRepo, storage, { add: jest.fn(async () => undefined) } as never);

    const schedule = await prisma.reportSchedule.create({
      data: {
        reportType: 'IFTA',
        format: 'CSV',
        params: { quarter: '2026-Q3' },
        cron: '0 6 * * 1',
        timezone: 'UTC',
        recipients: [],
        enabled: true,
        nextRunAt: new Date('2020-01-01T00:00:00.000Z'), // long due
        createdById: userId,
      },
    });
    scheduleIds.push(schedule.id);

    const tickQueue = { add: jest.fn(async () => undefined) };
    const generateQueue = { add: jest.fn(async () => undefined) };
    const processor = new ReportSchedulerProcessor(
      prismaService,
      schedulesRepo,
      reportsService,
      { isTest: true } as never,
      tickQueue as never,
      generateQueue as never,
    );

    const now = new Date('2026-09-14T06:00:00.000Z');
    const result = await processor.runTick(now);
    expect(result.due).toBeGreaterThanOrEqual(1);
    expect(result.enqueued).toBeGreaterThanOrEqual(1);

    const reloaded = await prisma.reportSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(reloaded.lastRunAt?.toISOString()).toBe(now.toISOString());
    expect(reloaded.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());

    const created = await prisma.report.findFirst({ where: { requestedById: userId, type: 'IFTA' }, orderBy: { requestedAt: 'desc' } });
    expect(created).not.toBeNull();
    if (created) reportIds.push(created.id);
  });
});
