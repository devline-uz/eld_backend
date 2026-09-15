/**
 * OneBook ELD — mock generator: reports (see prisma/mock/README.md for the contract).
 *
 * Owns: `IftaSegment` (computed via the real `IftaSegmentsService.computeForDate`, never
 * hand-written mileage), `FuelPurchase`, `Report` + `ReportSchedule`, `AlertRule` +
 * `AlertDelivery` + this domain's `Notification` rows, `Integration` + `WebhookDelivery`.
 *
 * Runs LAST in the pipeline (`core -> users -> hos -> ingest -> compliance -> fleet ->
 * safety-comms -> reports`) because IFTA segments need mock telemetry (`ingest`) and alert
 * notifications link to real violations/defects/safety events/geofences created by
 * `compliance`/`fleet`/`safety-comms`.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Prisma, PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import cronParser from 'cron-parser';
import { MOCK_TAG, MOCK_UNIT_PREFIX, MOCK_EMAIL_DOMAIN, MockContext, clampToNow } from '../context';

// Reused, real business logic — NOT reimplemented here (contract: "Do not hand-write mileage").
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { IftaSegmentsService } from '../../../src/modules/reports/ifta/ifta-segments.service';
import type { IftaSegmentsRepository } from '../../../src/modules/reports/ifta/ifta-segments.repository';
import { IftaReportGenerator } from '../../../src/modules/reports/generators/ifta-report.generator';
import { DvirReportGenerator } from '../../../src/modules/reports/generators/dvir-report.generator';
import type { PrismaService } from '../../../src/core/prisma/prisma.service';
import type { DvirReportParamsDto } from '../../../src/modules/reports/dto/reports.dto';

const MOCK_MARK = `[${MOCK_TAG}]`;

// ---------------------------------------------------------------------------------------
// Small S3/MinIO client (bypasses Nest DI — same endpoint/bucket the running API/worker use).
// ---------------------------------------------------------------------------------------
function buildS3Client(): { client: S3Client; bucket: string } {
  const bucket = process.env.S3_BUCKET ?? 'onebook-dev';
  const client = new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:19000',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'onebookadmin',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'localdevonly',
    },
  });
  return { client, bucket };
}

async function uploadStream(
  s3: { client: S3Client; bucket: string },
  key: string,
  body: NodeJS.ReadableStream,
  contentType: string,
): Promise<number> {
  let sizeBytes = 0;
  body.on('data', (chunk: Buffer) => (sizeBytes += chunk.length));
  const upload = new Upload({
    client: s3.client,
    params: { Bucket: s3.bucket, Key: key, Body: body as unknown as import('node:stream').Readable, ContentType: contentType },
  });
  await upload.done();
  return sizeBytes;
}

async function uploadBuffer(s3: { client: S3Client; bucket: string }, key: string, body: Buffer, contentType: string): Promise<number> {
  await s3.client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: body, ContentType: contentType }));
  return body.length;
}

/** Builds a real, spec-valid single-page PDF (correct xref byte offsets, computed here rather
 * than hard-coded) for report types with no standalone-runnable real generator (`FMCSA_PACK`
 * needs Puppeteer + templates wired through the worker's DI graph). Small (~700 bytes) but a
 * PDF reader opens it — this is a real downloadable file, not a placeholder blob. */
export function buildMinimalPdf(title: string, lines: string[]): Buffer {
  const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const textOps = [
    `BT /F1 14 Tf 40 260 Td (${esc(title)}) Tj ET`,
    ...lines.map((l, i) => `BT /F1 10 Tf 40 ${230 - i * 16} Td (${esc(l)}) Tj ET`),
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 340 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(textOps, 'utf8')} >>\nstream\n${textOps}\nendstream`,
  ];
  const header = '%PDF-1.4\n';
  let body = header;
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'utf8'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(body, 'utf8');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer, 'utf8');
}

// ---------------------------------------------------------------------------------------
// AES-256-GCM cipher for Integration.config secrets — same algorithm/format as
// src/modules/integrations/lib/secret-cipher.ts, reproduced here (not imported) only because
// the real `IntegrationCipherService` needs `AppConfigService`/Nest DI to construct; the wire
// format (`v1:<iv>:<tag>:<ciphertext>`, AES-256-GCM) is copied byte-for-byte so what we write
// decrypts correctly through the real service at request time.
// ---------------------------------------------------------------------------------------
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
const INTEGRATION_KEY = Buffer.from(
  process.env.INTEGRATION_ENCRYPTION_KEY ?? 'ZGV2LW9ubHktMzItYnl0ZS1rZXktY2hhbmdlLW1lISE=',
  'base64',
);
function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', INTEGRATION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}
export function encryptSecretFields(config: Record<string, unknown>): Record<string, unknown> {
  const SECRET_KEY_PATTERN = /secret|token|password|api[_-]?key|signing|private[_-]?key|access[_-]?key/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = SECRET_KEY_PATTERN.test(k) && typeof v === 'string' ? encryptSecret(v) : v;
  }
  return out;
}
export function computeWebhookSignature(secret: string, timestampSec: number, rawBody: string): string {
  const hmac = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${hmac}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function createManyBatched<T>(
  model: { createMany: (args: { data: T[]; skipDuplicates?: boolean }) => Promise<unknown> },
  rows: T[],
): Promise<number> {
  for (const batch of chunk(rows, 5000)) {
    await model.createMany({ data: batch, skipDuplicates: true });
  }
  return rows.length;
}

// =========================================================================================
// 1. IFTA segments — via the real IftaSegmentsService, scoped to mock vehicles only.
// =========================================================================================

/** Duck-typed drop-in for `IftaSegmentsRepository`, scoped to mock (`M1...`) vehicles only so
 * the nightly-job logic never touches the seeded units 101-120 (their 3 existing IftaSegment
 * rows, and any IftaSegment rows for them at all, are off-limits). */
function buildScopedIftaRepo(prisma: PrismaClient, mockVehicleIds: string[]) {
  const idSet = mockVehicleIds;
  return {
    async distinctVehicleIdsWithTelemetry(from: Date, to: Date): Promise<{ vehicleId: string }[]> {
      return prisma.telemetryPoint.findMany({
        where: { time: { gte: from, lte: to }, vehicleId: { in: idSet } },
        distinct: ['vehicleId'],
        select: { vehicleId: true },
      });
    },
    existingSegments(vehicleId: string, date: Date) {
      return prisma.iftaSegment.findMany({ where: { vehicleId, date }, select: { jurisdiction: true, locked: true } });
    },
    telemetryForVehicleDay(vehicleId: string, from: Date, to: Date) {
      return prisma.telemetryPoint.findMany({
        where: { vehicleId, time: { gte: from, lte: to } },
        orderBy: { time: 'asc' },
        select: { time: true, latitude: true, longitude: true, odometerMi: true, driverId: true },
      });
    },
    upsertSegment(vehicleId: string, jurisdiction: string, date: Date, driverId: string | null, distanceMi: number) {
      return prisma.iftaSegment.upsert({
        where: { vehicleId_jurisdiction_date: { vehicleId, jurisdiction, date } },
        create: { vehicleId, driverId, jurisdiction, date, distanceMi },
        update: { distanceMi, driverId },
      });
    },
    async lockQuarter(qStart: Date, qEnd: Date): Promise<number> {
      const res = await prisma.iftaSegment.updateMany({
        where: { locked: false, date: { gte: qStart, lte: qEnd }, vehicleId: { in: idSet } },
        data: { locked: true },
      });
      return res.count;
    },
  };
}

async function computeIftaSegments(ctx: MockContext, mockVehicleIds: string[]): Promise<number> {
  // Structurally compatible with `IftaSegmentsRepository` (same 5 public methods, no private
  // members) but scoped to mock vehicles only — cast needed only because this plain object
  // isn't literally an instance of the class.
  const repo = buildScopedIftaRepo(ctx.prisma, mockVehicleIds) as unknown as IftaSegmentsRepository;
  const service = new IftaSegmentsService(repo);

  let cursor = DateTime.fromJSDate(ctx.from).toUTC().startOf('day');
  const end = DateTime.fromJSDate(ctx.to).toUTC().startOf('day');
  let totalUpserted = 0;
  let totalLocked = 0;
  let days = 0;
  while (cursor <= end) {
    const result = await service.computeForDate(cursor);
    totalUpserted += result.segmentsUpserted;
    totalLocked += result.segmentsLocked;
    days += 1;
    if (days % 30 === 0) ctx.log(`ifta: processed ${days} days, upserted=${totalUpserted} locked=${totalLocked}`);
    cursor = cursor.plus({ days: 1 });
  }
  ctx.log(`ifta: done — ${days} days, ${totalUpserted} segment upserts, ${totalLocked} rows locked by quarter close`);
  return totalUpserted;
}

// =========================================================================================
// 2. Fuel purchases — derived from the just-computed IftaSegment mileage per vehicle/day.
// =========================================================================================

const TRUCK_STOPS = [
  'Pilot Flying J', "Love's Travel Stop", 'TA Travel Center', 'Petro Stopping Center',
  'Speedway', "Sapp Bros.", 'Roady\'s Truck Stop', 'QuikTrip',
];

export interface IftaSegmentLite {
  vehicleId: string;
  driverId: string | null;
  jurisdiction: string;
  date: Date;
  distanceMi: number;
}

export interface VehicleDayTotal {
  miles: number;
  jurisdiction: string;
  jMiles: number;
  driverId: string | null;
}

/** Groups per-jurisdiction `IftaSegment` rows into one (vehicle, date) total, picking the
 * jurisdiction with the most miles that day as the "dominant" one a refuel stop would plausibly
 * happen in. Pure/exported so `reports.helpers.spec.ts` can test the grouping without a DB. */
export function groupSegmentsByVehicleDay(segments: IftaSegmentLite[]): Map<string, Map<string, VehicleDayTotal>> {
  const byVehicleDay = new Map<string, Map<string, VehicleDayTotal>>();
  for (const s of segments) {
    const dateKey = s.date.toISOString().slice(0, 10);
    let byDate = byVehicleDay.get(s.vehicleId);
    if (!byDate) {
      byDate = new Map();
      byVehicleDay.set(s.vehicleId, byDate);
    }
    const existing = byDate.get(dateKey);
    if (!existing || s.distanceMi > existing.jMiles) {
      byDate.set(dateKey, {
        miles: (existing?.miles ?? 0) + s.distanceMi,
        jurisdiction: s.distanceMi > (existing?.jMiles ?? -1) ? s.jurisdiction : existing!.jurisdiction,
        jMiles: Math.max(existing?.jMiles ?? 0, s.distanceMi),
        driverId: s.driverId ?? existing?.driverId ?? null,
      });
    } else {
      existing.miles += s.distanceMi;
    }
  }
  return byVehicleDay;
}

export interface FillEvent {
  dateKey: string;
  jurisdiction: string;
  driverId: string | null;
  milesSinceFill: number;
  gallons: number;
}

/** Walks a vehicle's chronological daily mileage totals and places a refuel stop every time
 * cumulative mileage since the last stop crosses `fillThreshold` — the ~500-900mi range a
 * ~6-7 MPG tractor's tank realistically covers. Pure/exported for unit testing. */
export function planFillEvents(days: Array<[string, VehicleDayTotal]>, mpg: number, fillThreshold: number): FillEvent[] {
  const events: FillEvent[] = [];
  let milesSinceFill = 0;
  let jurisdiction = '';
  let driverId: string | null = null;
  for (const [dateKey, day] of days) {
    milesSinceFill += day.miles;
    jurisdiction = day.jurisdiction;
    driverId = day.driverId ?? driverId;
    if (milesSinceFill < fillThreshold) continue;
    events.push({ dateKey, jurisdiction, driverId, milesSinceFill, gallons: milesSinceFill / mpg });
    milesSinceFill = 0;
  }
  return events;
}

async function generateFuelPurchases(ctx: MockContext, mockVehicleIds: string[]): Promise<number> {
  const segments = await ctx.prisma.iftaSegment.findMany({
    where: { vehicleId: { in: mockVehicleIds } },
    select: { vehicleId: true, driverId: true, jurisdiction: true, date: true, distanceMi: true },
    orderBy: [{ vehicleId: 'asc' }, { date: 'asc' }],
  });

  const byVehicleDay = groupSegmentsByVehicleDay(segments);

  const rows: Prisma.FuelPurchaseCreateManyInput[] = [];
  let externalSeq = 0;
  for (const [vehicleId, byDate] of byVehicleDay) {
    const mpg = ctx.rng.float(5.8, 7.2) * ctx.rng.float(0.95, 1.05); // fleet target ~6-7 MPG
    const days = Array.from(byDate.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const fillThreshold = ctx.rng.int(500, 900);
    for (const event of planFillEvents(days, mpg, fillThreshold)) {
      const pricePerGal = ctx.rng.float(3.15, 4.55);
      const totalUsd = event.gallons * pricePerGal;
      const purchasedAt = clampToNow(
        DateTime.fromISO(event.dateKey, { zone: 'utc' }).set({ hour: ctx.rng.int(5, 21) }).toJSDate(),
        ctx,
      );
      externalSeq += 1;
      rows.push({
        vehicleId,
        driverId: event.driverId,
        purchasedAt,
        jurisdiction: event.jurisdiction,
        gallons: Number(event.gallons.toFixed(2)),
        pricePerGal: Number(pricePerGal.toFixed(3)),
        totalUsd: Number(totalUsd.toFixed(2)),
        vendor: ctx.rng.pick(TRUCK_STOPS),
        receiptId: ctx.rng.chance(0.3) ? `receipts/mock/fuel-${vehicleId.slice(0, 8)}-${event.dateKey}.jpg` : null,
        source: MOCK_TAG,
        externalId: `mock-fuel-${vehicleId}-${externalSeq}`,
        odometerMi: null,
      });
    }
  }

  await ctx.prisma.fuelPurchase.deleteMany({ where: { vehicleId: { in: mockVehicleIds } } });
  return createManyBatched(ctx.prisma.fuelPurchase, rows);
}

// =========================================================================================
// 3. Report records + schedules
// =========================================================================================

const REPORT_TYPES = ['IFTA', 'ACTIVITY', 'DVIR', 'FMCSA_PACK', 'UNIDENTIFIED', 'SAFETY'] as const;
const FORMAT_FOR: Record<string, 'CSV' | 'PDF'> = {
  IFTA: 'CSV', ACTIVITY: 'CSV', DVIR: 'CSV', FMCSA_PACK: 'PDF', UNIDENTIFIED: 'CSV', SAFETY: 'CSV',
};

function paramsFor(type: string, ctx: MockContext): Record<string, unknown> {
  const to = DateTime.fromJSDate(ctx.to);
  if (type === 'IFTA') return { quarter: ctx.rng.pick(['2026-Q2', '2026-Q3']) };
  const days = ctx.rng.int(1, 8);
  const from = to.minus({ days: days + ctx.rng.int(0, 150) });
  return { from: from.toISODate(), to: from.plus({ days }).toISODate() };
}

async function generateReportsAndSchedules(ctx: MockContext, requesterIds: string[]): Promise<{ reports: number; schedules: number; realFiles: number }> {
  await ctx.prisma.report.deleteMany({ where: { requestedById: { in: requesterIds } } });
  await ctx.prisma.reportSchedule.deleteMany({ where: { createdById: { in: requesterIds } } });

  const statuses = ['QUEUED', 'RUNNING', 'READY', 'FAILED'] as const;
  const rows: Prisma.ReportCreateManyInput[] = [];
  const N = 240;
  for (let i = 0; i < N; i++) {
    const type = ctx.rng.pick(REPORT_TYPES);
    const format = FORMAT_FOR[type];
    const status = ctx.rng.pick(statuses);
    const requestedAt = clampToNow(
      DateTime.fromJSDate(ctx.from).plus({ minutes: ctx.rng.int(0, DateTime.fromJSDate(ctx.to).diff(DateTime.fromJSDate(ctx.from), 'minutes').minutes) }).toJSDate(),
      ctx,
    );
    const isTerminal = status === 'READY' || status === 'FAILED';
    const completedAt = isTerminal ? clampToNow(DateTime.fromJSDate(requestedAt).plus({ seconds: ctx.rng.int(5, 120) }).toJSDate(), ctx) : null;
    rows.push({
      type,
      format,
      params: paramsFor(type, ctx) as Prisma.InputJsonValue,
      status,
      fileKey: null, // every READY row gets a real file via ensureReadyReportFiles() below
      fileSizeBytes: null,
      rowCount: status === 'READY' ? ctx.rng.int(10, 5000) : null,
      error: status === 'FAILED' ? 'mock: upstream data gap for the requested window' : null,
      requestedById: ctx.rng.pick(requesterIds),
      requestedAt,
      completedAt,
      expiresAt: status === 'READY' ? DateTime.fromJSDate(completedAt!).plus({ months: 24 }).toJSDate() : null,
    });
  }
  await createManyBatched(ctx.prisma.report, rows);

  const realFiles = await ensureReadyReportFiles(ctx);

  const schedRows = await buildAndInsertSchedules(ctx, requesterIds);
  return { reports: rows.length, schedules: schedRows, realFiles };
}

/**
 * B-054 (see bugs.md) — every READY report must be downloadable — a READY row with no
 * `fileKey` 409s the panel's download button. IFTA and DVIR go through the real, standalone
 * generators (same code the worker uses); the remaining types have no standalone-runnable
 * real generator (ACTIVITY needs LogsService's full DI graph, FMCSA_PACK needs Puppeteer +
 * templates, SAFETY/UNIDENTIFIED have no generator at all — not wired into `ReportProcessor`
 * yet), so those get a real, valid, minimal file in the report's own format instead. Any
 * report we still can't produce a file for is downgraded to FAILED with an error, never left
 * READY with nothing to download. Exported and idempotent (re-checks every READY row, not just
 * newly-created ones) so it can also be run standalone to repair an existing DB without
 * recreating every `Report` row.
 */
export async function ensureReadyReportFiles(ctx: MockContext): Promise<number> {
  const s3 = buildS3Client();
  let realFiles = 0;
  const iftaGen = new IftaReportGenerator(ctx.prisma as unknown as PrismaService);
  const dvirGen = new DvirReportGenerator(ctx.prisma as unknown as PrismaService);
  // No `requestedById` filter: `Report` is exclusively this generator's table (no other mock
  // domain writes to it — see prisma/mock/README.md's ownership list), and a previous version
  // of this function filtered by a freshly re-sampled `requesterIds` array whose `take: 30`
  // query has no `orderBy`, so it silently missed READY rows requested by mock users outside
  // that arbitrary sample on a second run (see bugs.md B-054 fix note).
  // `fileKey: null` filter makes re-runs cheap: only rows still missing a file are touched, so
  // a retry after a transient failure (e.g. a connection-limit error) doesn't re-upload the
  // files this function already produced on a previous call.
  const readyReports = await ctx.prisma.report.findMany({ where: { status: 'READY', fileKey: null } });
  for (const r of readyReports) {
    try {
      const key = `reports/${r.id}.${r.format === 'PDF' ? 'pdf' : 'csv'}`;
      let sizeBytes: number;
      let rowCount: number | null = r.rowCount;
      if (r.type === 'IFTA') {
        const quarter = (r.params as { quarter?: string }).quarter ?? '2026-Q2';
        const { stream, rowCount: n } = await iftaGen.stream({ quarter });
        sizeBytes = await uploadStream(s3, key, stream, 'text/csv');
        rowCount = n;
      } else if (r.type === 'DVIR') {
        const p = r.params as { from: string; to: string };
        const { stream } = dvirGen.stream(p as unknown as DvirReportParamsDto);
        sizeBytes = await uploadStream(s3, key, stream, 'text/csv');
      } else if (r.type === 'FMCSA_PACK') {
        const p = r.params as { from?: string; to?: string; driverId?: string };
        const pdf = buildMinimalPdf(`FMCSA Compliance Pack ${MOCK_MARK}`, [
          `Window: ${p.from ?? '?'} .. ${p.to ?? '?'}`,
          p.driverId ? `Driver: ${p.driverId}` : 'Driver: all drivers',
          'This is a mock cover sheet (no Puppeteer render in the mock generator).',
        ]);
        sizeBytes = await uploadBuffer(s3, key, pdf, 'application/pdf');
      } else {
        // ACTIVITY / SAFETY / UNIDENTIFIED — minimal, valid, type-shaped CSV.
        const p = r.params as { from?: string; to?: string };
        const header =
          r.type === 'ACTIVITY'
            ? 'driverId,driverName,date,drivingHours,onDutyHours,totalDistanceMi,certified'
            : r.type === 'SAFETY'
              ? 'driverId,vehicleId,eventType,occurredAt,severity'
              : 'vehicleId,startAt,endAt,distanceMi,status';
        const sampleRow =
          r.type === 'ACTIVITY'
            ? `mock_sample,Mock Driver,${p.from ?? '2026-07-01'},8.50,10.25,412,true`
            : r.type === 'SAFETY'
              ? `mock_sample,M1001,SPEEDING,${p.from ?? '2026-07-01'}T12:00:00.000Z,3`
              : `M1001,${p.from ?? '2026-07-01'}T06:00:00.000Z,${p.from ?? '2026-07-01'}T06:45:00.000Z,22,PENDING`;
        const csv = `${header}\n${sampleRow}\n`;
        sizeBytes = await uploadBuffer(s3, key, Buffer.from(csv, 'utf8'), 'text/csv');
        rowCount = 1;
      }
      await ctx.prisma.report.update({ where: { id: r.id }, data: { fileKey: key, fileSizeBytes: sizeBytes, rowCount } });
      realFiles += 1;
    } catch (err) {
      ctx.log(`reports: could not produce a file for READY ${r.type} report ${r.id} — downgrading to FAILED: ${(err as Error).message}`);
      await ctx.prisma.report.update({
        where: { id: r.id },
        data: { status: 'FAILED', error: `mock: file generation failed — ${(err as Error).message}`.slice(0, 500), fileKey: null, expiresAt: null },
      });
    }
  }
  return realFiles;
}

/** Weekly / monthly / quarterly report schedules, active and paused. */
async function buildAndInsertSchedules(ctx: MockContext, requesterIds: string[]): Promise<number> {
  const scheduleDefs: Array<{ reportType: 'IFTA' | 'ACTIVITY' | 'DVIR' | 'FMCSA_PACK'; format: 'CSV' | 'PDF'; cron: string; params: Record<string, unknown>; enabled: boolean }> = [
    { reportType: 'IFTA', format: 'CSV', cron: '0 6 1 */3 *', params: { quarter: '2026-Q3' }, enabled: true },
    { reportType: 'ACTIVITY', format: 'CSV', cron: '0 5 * * 1', params: {}, enabled: true },
    { reportType: 'ACTIVITY', format: 'CSV', cron: '0 5 1 * *', params: {}, enabled: false },
    { reportType: 'DVIR', format: 'CSV', cron: '0 4 1 * *', params: {}, enabled: true },
    { reportType: 'FMCSA_PACK', format: 'PDF', cron: '0 7 1 */3 *', params: {}, enabled: false },
  ];
  const schedRows: Prisma.ReportScheduleCreateManyInput[] = scheduleDefs.map((d) => {
    const nextRunAt = cronParser.parseExpression(d.cron, { currentDate: ctx.to, tz: 'UTC' }).next().toDate();
    return {
      reportType: d.reportType,
      format: d.format,
      params: d.params as Prisma.InputJsonValue,
      cron: d.cron,
      timezone: 'UTC',
      recipients: ['sarah.chen@universal-logistics.example', `mock.dispatch${MOCK_EMAIL_DOMAIN}`],
      enabled: d.enabled,
      lastRunAt: d.enabled ? clampToNow(DateTime.fromJSDate(ctx.to).minus({ days: 7 }).toJSDate(), ctx) : null,
      nextRunAt, // exception to "no future timestamps" — schedules point forward by design
      createdById: requesterIds[0],
    };
  });
  await createManyBatched(ctx.prisma.reportSchedule, schedRows);
  return schedRows.length;
}

// =========================================================================================
// 4. Alert rules + deliveries + notifications
// =========================================================================================

interface AlertRuleDef {
  key: string;
  name: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  event: string;
  channels: string[];
  recipients: Record<string, unknown>;
  throttle?: { perDriverPerDay?: number; cooldownMin?: number };
  quietHours?: { from: string; to: string; timezone: string };
  enabled: boolean;
}

const ALERT_RULE_DEFS: AlertRuleDef[] = [
  { key: 'mock_hos_violation', name: `HOS violation ${MOCK_MARK}`, severity: 'CRITICAL', event: 'alert.hos_violation', channels: ['IN_APP', 'EMAIL'], recipients: { roles: ['FLEET_MANAGER', 'DISPATCHER'], subjectDriver: true }, throttle: { perDriverPerDay: 3, cooldownMin: 30 }, enabled: true },
  { key: 'mock_speeding', name: `Speeding event ${MOCK_MARK}`, severity: 'WARNING', event: 'alert.harsh_event', channels: ['IN_APP'], recipients: { roles: ['FLEET_MANAGER'], subjectDriver: true }, throttle: { perDriverPerDay: 5, cooldownMin: 15 }, quietHours: { from: '22:00', to: '06:00', timezone: 'America/New_York' }, enabled: true },
  { key: 'mock_geofence_enter', name: `Geofence enter ${MOCK_MARK}`, severity: 'INFO', event: 'alert.geofence_enter', channels: ['IN_APP', 'WEBHOOK'], recipients: { roles: ['DISPATCHER'] }, enabled: true },
  { key: 'mock_geofence_exit', name: `Geofence exit ${MOCK_MARK}`, severity: 'INFO', event: 'alert.geofence_exit', channels: ['IN_APP', 'WEBHOOK'], recipients: { roles: ['DISPATCHER'] }, enabled: true },
  { key: 'mock_dvir_defect', name: `DVIR critical defect ${MOCK_MARK}`, severity: 'CRITICAL', event: 'alert.vehicle_out_of_service', channels: ['IN_APP', 'EMAIL'], recipients: { roles: ['FLEET_MANAGER', 'ADMIN'] }, enabled: true },
  { key: 'mock_maintenance_due', name: `Maintenance due ${MOCK_MARK}`, severity: 'WARNING', event: 'alert.maintenance_due', channels: ['IN_APP'], recipients: { roles: ['FLEET_MANAGER'] }, throttle: { perDriverPerDay: 1 }, enabled: true },
  { key: 'mock_eld_malfunction', name: `ELD malfunction ${MOCK_MARK}`, severity: 'CRITICAL', event: 'alert.eld_malfunction', channels: ['IN_APP', 'EMAIL'], recipients: { roles: ['ADMIN', 'FLEET_MANAGER'], subjectDriver: true }, enabled: true },
  { key: 'mock_unidentified_driving', name: `Unidentified driving ${MOCK_MARK}`, severity: 'WARNING', event: 'alert.unidentified_driving', channels: ['IN_APP'], recipients: { roles: ['DISPATCHER'] }, throttle: { cooldownMin: 60 }, enabled: true },
  { key: 'mock_uncertified_logs', name: `Uncertified logs (8-day) ${MOCK_MARK}`, severity: 'WARNING', event: 'alert.uncertified_logs', channels: ['IN_APP', 'EMAIL'], recipients: { roles: ['FLEET_MANAGER'], subjectDriver: true }, enabled: false },
  { key: 'mock_eld_disconnected', name: `ELD disconnected ${MOCK_MARK}`, severity: 'INFO', event: 'alert.eld_disconnected', channels: ['IN_APP'], recipients: { roles: ['DISPATCHER'] }, enabled: false },
];

export async function generateAlertRules(ctx: MockContext): Promise<{ id: string; def: AlertRuleDef }[]> {
  // B-053: `AlertDelivery.alertRuleId` / `Notification.type` (this domain's convention, see
  // `generateAlertDeliveriesAndNotifications`) reference the OLD rule ids from a previous run.
  // Deleting AlertRule first (children still pointing at it) violates the FK — delete the
  // children by the old ids before the parent, every time this re-runs.
  const existing = await ctx.prisma.alertRule.findMany({
    where: { key: { in: ALERT_RULE_DEFS.map((d) => d.key) } },
    select: { id: true },
  });
  const existingIds = existing.map((r) => r.id);
  if (existingIds.length > 0) {
    await ctx.prisma.alertDelivery.deleteMany({ where: { alertRuleId: { in: existingIds } } });
    await ctx.prisma.notification.deleteMany({ where: { type: { in: existingIds } } });
  }
  await ctx.prisma.alertRule.deleteMany({ where: { key: { in: ALERT_RULE_DEFS.map((d) => d.key) } } });
  const created: { id: string; def: AlertRuleDef }[] = [];
  for (const def of ALERT_RULE_DEFS) {
    const row = await ctx.prisma.alertRule.create({
      data: {
        key: def.key,
        name: def.name,
        severity: def.severity,
        conditions: [{ event: def.event }] as Prisma.InputJsonValue,
        channels: def.channels,
        recipients: def.recipients as Prisma.InputJsonValue,
        throttle: (def.throttle ?? null) as Prisma.InputJsonValue,
        quietHours: (def.quietHours ?? null) as Prisma.InputJsonValue,
        enabled: def.enabled,
        isSystem: false,
      },
    });
    created.push({ id: row.id, def });
  }
  return created;
}

export async function generateAlertDeliveriesAndNotifications(
  ctx: MockContext,
  rules: { id: string; def: AlertRuleDef }[],
  mockVehicleIds: string[],
): Promise<{ deliveries: number; notifications: number }> {
  await ctx.prisma.alertDelivery.deleteMany({ where: { alertRuleId: { in: rules.map((r) => r.id) } } });
  await ctx.prisma.notification.deleteMany({ where: { type: { in: rules.map((r) => r.id) } } });

  const ruleByKey = new Map(rules.map((r) => [r.def.key, r]));
  const sarah = await ctx.prisma.user.findUnique({ where: { email: 'sarah.chen@universal-logistics.example' } });
  const managerUsers = await ctx.prisma.user.findMany({
    where: { status: 'ACTIVE', role: { key: { in: ['ADMIN', 'FLEET_MANAGER', 'DISPATCHER'] } } },
    select: { id: true },
    take: 20,
  });

  // Real subject objects created by other domains — best-effort; 0 rows is fine (that domain
  // may not have run yet in this environment), we just create fewer linked deliveries then.
  const [violations, defects, safetyEvents, maintSchedules] = await Promise.all([
    ctx.prisma.hosViolation.findMany({ where: { driver: { username: { startsWith: 'mock_' } } }, select: { id: true, driverId: true, occurredAt: true }, take: 500 }),
    ctx.prisma.defect.findMany({ where: { vehicle: { unitNumber: { startsWith: MOCK_UNIT_PREFIX } }, severity: 'CRITICAL' }, select: { id: true, vehicleId: true, createdAt: true }, take: 300 }),
    ctx.prisma.safetyEvent.findMany({ where: { vehicleId: { in: mockVehicleIds } }, select: { id: true, driverId: true, vehicleId: true, occurredAt: true, type: true }, take: 800 }),
    ctx.prisma.maintenanceSchedule.findMany({ where: { vehicleId: { in: mockVehicleIds }, enabled: true }, select: { id: true, vehicleId: true, nextDueAt: true }, take: 300 }),
  ]).catch(() => [[], [], [], []] as [never[], never[], never[], never[]]);

  const deliveryRows: Prisma.AlertDeliveryCreateManyInput[] = [];
  const notificationRows: Prisma.NotificationCreateManyInput[] = [];
  const statusPool = ['SENT', 'SENT', 'SENT', 'FAILED', 'SUPPRESSED', 'QUEUED'] as const;

  function addDelivery(rule: { id: string; def: AlertRuleDef }, recipientKind: 'user' | 'driver', recipientId: string, subjectType: string, subjectId: string, atInput: Date, forceUnread = false): void {
    // B-053: `at` here can come from another domain's table (HosViolation.occurredAt,
    // SafetyEvent.occurredAt, Defect.createdAt) written by a generator that ran with a
    // slightly later "now" snapshot than ours — clamp centrally so no Notification/
    // AlertDelivery this function writes can ever land after real `now` (hard rule, no
    // future timestamps), regardless of which call site forgot to.
    const at = clampToNow(atInput, ctx);
    const status = ctx.rng.pick(statusPool);
    const recipientKey = `${recipientKind}:${recipientId}`;
    deliveryRows.push({
      alertRuleId: rule.id,
      channel: ctx.rng.pick(rule.def.channels.filter((c) => c !== 'SMS')),
      recipient: recipientKey,
      subjectType,
      subjectId,
      payload: { title: rule.def.name, subjectType, subjectId, mock: true } as Prisma.InputJsonValue,
      status,
      attempts: status === 'FAILED' ? ctx.rng.int(1, 3) : 1,
      error: status === 'FAILED' ? 'mock: delivery endpoint unreachable' : null,
      sentAt: status === 'SENT' ? at : null,
      createdAt: at,
    });
    if (rule.def.channels.includes('IN_APP')) {
      const unread = forceUnread || ctx.rng.chance(0.4);
      notificationRows.push({
        userId: recipientKind === 'user' ? recipientId : null,
        driverId: recipientKind === 'driver' ? recipientId : null,
        type: rule.id,
        title: rule.def.name,
        body: `${rule.def.name} — subject ${subjectType}:${subjectId.slice(0, 8)}`,
        objectType: subjectType,
        objectId: subjectId,
        readAt: unread ? null : clampToNow(DateTime.fromJSDate(at).plus({ minutes: ctx.rng.int(2, 600) }).toJSDate(), ctx),
        createdAt: at,
      });
    }
  }

  const hosRule = ruleByKey.get('mock_hos_violation');
  if (hosRule) for (const v of violations) addDelivery(hosRule, 'driver', v.driverId, 'HosViolation', v.id, v.occurredAt);

  const speedingRule = ruleByKey.get('mock_speeding');
  if (speedingRule) {
    for (const e of safetyEvents) {
      if (e.type !== 'SPEEDING' || !e.driverId) continue;
      addDelivery(speedingRule, 'driver', e.driverId, 'SafetyEvent', e.id, e.occurredAt);
    }
  }

  const dvirRule = ruleByKey.get('mock_dvir_defect');
  if (dvirRule) for (const d of defects) for (const u of managerUsers.slice(0, 3)) addDelivery(dvirRule, 'user', u.id, 'Defect', d.id, d.createdAt);

  const maintRule = ruleByKey.get('mock_maintenance_due');
  if (maintRule) {
    for (const m of maintSchedules) {
      if (!m.nextDueAt) continue;
      const at = clampToNow(m.nextDueAt, ctx);
      for (const u of managerUsers.slice(0, 2)) addDelivery(maintRule, 'user', u.id, 'MaintenanceSchedule', m.id, at);
    }
  }

  // Sarah Chen gets a stack of unread bell notifications regardless of upstream data
  // availability (topbar bell must show unread items for her per the brief).
  if (sarah) {
    const windowStart = DateTime.fromJSDate(ctx.from);
    const windowEnd = DateTime.fromJSDate(ctx.to);
    const spanMin = windowEnd.diff(windowStart, 'minutes').minutes;
    for (const rule of rules.slice(0, 6)) {
      for (let i = 0; i < 4; i++) {
        const at = windowStart.plus({ minutes: ctx.rng.int(0, spanMin) }).toJSDate();
        addDelivery(rule, 'user', sarah.id, 'AlertRule', rule.id, at, i < 2);
      }
    }
  }

  const deliveries = await createManyBatched(ctx.prisma.alertDelivery, deliveryRows);
  const notifications = await createManyBatched(ctx.prisma.notification, notificationRows);
  return { deliveries, notifications };
}

/**
 * B-0xx (see bugs.md) — self-heals `Notification`/`AlertDelivery` rows whose
 * `objectType='HosViolation'` reference no longer exists. Root cause is NOT the real
 * `HosRecalcService` (`src/modules/hos-recalc/*` upserts `HosViolation` by the stable
 * `[driverId, logDate, type]` key and only ever resolves/auto-clears — never deletes, see
 * `hos-violation-plan.ts:9` "never deleted — the audit trail stays") and NOT the real
 * notifications module (`Notification.objectId` is a loose reference with no FK, so a stale
 * id never 500s the API, only silently fails a UI deep-link). The fault is the MOCK `hos`
 * generator's own idempotent-rerun strategy (`prisma/mock/generators/hos.ts:238`,
 * `prisma.hosViolation.deleteMany(...)` on its GENERATE path) hard-deleting and recreating
 * violations with fresh ids whenever it re-runs after this generator already linked
 * notifications to the old ones — a cross-generator ordering issue, not a `src/` bug. Per the
 * mock framework's "never touch other agents' generator files" rule, `hos.ts` is not changed
 * here; this repairs the data (least-destructive: repoint to a same-driver, same-day
 * replacement violation where one exists) every time `reports` runs, so it self-heals instead
 * of accumulating.
 */
export async function repairOrphanedHosViolationLinks(ctx: MockContext): Promise<{ repointed: number; leftDangling: number }> {
  const [orphanNotifications, orphanDeliveries] = await Promise.all([
    ctx.prisma.$queryRaw<{ id: string; objectId: string; driverId: string | null; createdAt: Date }[]>`
      SELECT n.id, n."objectId", n."driverId", n."createdAt"
      FROM "Notification" n
      LEFT JOIN "HosViolation" v ON v.id = n."objectId"
      WHERE n."objectType" = 'HosViolation' AND v.id IS NULL
    `,
    ctx.prisma.$queryRaw<{ id: string; subjectId: string; recipient: string; createdAt: Date }[]>`
      SELECT d.id, d."subjectId", d.recipient, d."createdAt"
      FROM "AlertDelivery" d
      LEFT JOIN "HosViolation" v ON v.id = d."subjectId"
      WHERE d."subjectType" = 'HosViolation' AND v.id IS NULL
    `,
  ]);

  if (orphanNotifications.length === 0 && orphanDeliveries.length === 0) {
    return { repointed: 0, leftDangling: 0 };
  }

  // Cache replacement lookups per (driverId, yyyy-mm-dd) — several orphans usually share a day.
  const replacementCache = new Map<string, string | null>();
  async function findReplacement(driverId: string | null, createdAt: Date): Promise<string | null> {
    if (!driverId) return null;
    const day = createdAt.toISOString().slice(0, 10);
    const cacheKey = `${driverId}:${day}`;
    if (replacementCache.has(cacheKey)) return replacementCache.get(cacheKey)!;
    const dayStart = new Date(`${day}T00:00:00.000Z`);
    const dayEnd = new Date(`${day}T23:59:59.999Z`);
    const candidates = await ctx.prisma.hosViolation.findMany({
      where: { driverId, occurredAt: { gte: dayStart, lte: dayEnd } },
      select: { id: true, status: true },
      take: 10,
    });
    // Prefer an OPEN replacement over an already-RESOLVED/AUTO_CLEARED one; `status: 'asc'`
    // would sort AUTO_CLEARED before OPEN alphabetically, so pick in JS instead.
    const id = (candidates.find((c) => c.status === 'OPEN') ?? candidates[0])?.id ?? null;
    replacementCache.set(cacheKey, id);
    return id;
  }

  let repointed = 0;
  let leftDangling = 0;
  for (const n of orphanNotifications) {
    const replacementId = await findReplacement(n.driverId, n.createdAt);
    if (replacementId) {
      await ctx.prisma.notification.update({
        where: { id: n.id },
        data: { objectId: replacementId, body: `HOS violation (repointed by mock repair, was ${n.objectId.slice(0, 8)}…)` },
      });
      repointed += 1;
    } else {
      leftDangling += 1;
    }
  }
  for (const d of orphanDeliveries) {
    const driverId = d.recipient.startsWith('driver:') ? d.recipient.slice('driver:'.length) : null;
    const replacementId = await findReplacement(driverId, d.createdAt);
    if (replacementId) {
      await ctx.prisma.alertDelivery.update({ where: { id: d.id }, data: { subjectId: replacementId } });
      repointed += 1;
    } else {
      leftDangling += 1;
    }
  }
  ctx.log(`reports: repaired HosViolation links — repointed=${repointed} leftDangling=${leftDangling} (no same-driver/same-day replacement found; API tolerates this)`);
  return { repointed, leftDangling };
}

// =========================================================================================
// 5. Integrations + webhooks
// =========================================================================================

async function generateIntegrations(ctx: MockContext): Promise<{ integrations: number; webhookDeliveries: number }> {
  const providers: Array<{ provider: string; enabled: boolean; status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR'; config: Record<string, unknown>; lastError: string | null }> = [
    { provider: 'mcleod', enabled: true, status: 'CONNECTED', config: { baseUrl: 'https://mcleod.mock.onebook.example/api', companyId: 'UNIV01', apiKey: 'mock-mcleod-key-9f2a', syncFrequencyMin: 15 }, lastError: null },
    { provider: 'wex', enabled: true, status: 'CONNECTED', config: { accountNumber: '700-MOCK-4471', apiKey: 'mock-wex-key-77bd', cardProgram: 'fleet-diesel' }, lastError: null },
    { provider: 'comdata', enabled: false, status: 'DISCONNECTED', config: {}, lastError: null },
    { provider: 'quickbooks', enabled: true, status: 'ERROR', config: { clientId: 'mock-qbo-client', clientSecret: 'mock-qbo-secret-x1', realmId: '4620816365019', refreshToken: 'mock-refresh-token-abc' }, lastError: 'mock: OAuth refresh token expired — reconnect required' },
    { provider: 'slack', enabled: true, status: 'CONNECTED', config: { webhookUrl: 'https://hooks.slack.mock.onebook.example/services/T00/B00/mockmockmock', channel: '#fleet-alerts', signingSecret: 'mock-slack-signing-secret' }, lastError: null },
    { provider: 'webhook', enabled: true, status: 'CONNECTED', config: { url: 'https://partner.mock.onebook.example/webhooks/onebook', secret: 'mock-webhook-hmac-secret-4d21', events: ['alert', 'report.ready', 'trip_assigned'] }, lastError: null },
  ];

  await ctx.prisma.integration.deleteMany({ where: { provider: { in: providers.map((p) => p.provider) } } });
  for (const p of providers) {
    await ctx.prisma.integration.create({
      data: {
        provider: p.provider,
        enabled: p.enabled,
        config: encryptSecretFields(p.config) as Prisma.InputJsonValue,
        status: p.status,
        lastSyncAt: p.status === 'CONNECTED' ? clampToNow(DateTime.fromJSDate(ctx.to).minus({ hours: ctx.rng.int(1, 48) }).toJSDate(), ctx) : null,
        lastError: p.lastError,
      },
    });
  }

  const webhookIntegration = await ctx.prisma.integration.findUnique({ where: { provider: 'webhook' } });
  const secret = 'mock-webhook-hmac-secret-4d21';
  const eventTypes = ['alert', 'report.ready', 'trip_assigned', 'dvir.submitted'];
  const rows: Prisma.WebhookDeliveryCreateManyInput[] = [];
  const windowStart = DateTime.fromJSDate(ctx.from);
  const spanMin = DateTime.fromJSDate(ctx.to).diff(windowStart, 'minutes').minutes;
  for (let i = 0; i < 120; i++) {
    const at = windowStart.plus({ minutes: ctx.rng.int(0, spanMin) });
    const eventType = ctx.rng.pick(eventTypes);
    const payload = { eventType, mock: true, seq: i };
    const rawBody = JSON.stringify(payload);
    const signature = computeWebhookSignature(secret, Math.floor(at.toSeconds()), rawBody);
    const success = ctx.rng.chance(0.75);
    rows.push({
      integrationId: webhookIntegration?.id ?? null,
      url: 'https://partner.mock.onebook.example/webhooks/onebook',
      eventType,
      payload: payload as Prisma.InputJsonValue,
      signature,
      status: success ? 'SENT' : ctx.rng.pick(['FAILED', 'QUEUED'] as const),
      attempts: success ? 1 : ctx.rng.int(1, 3),
      httpStatus: success ? 200 : ctx.rng.pick([500, 503, 0]),
      responseBody: success ? 'ok' : 'mock: connection timed out',
      nextRetryAt: success ? null : clampToNow(at.plus({ seconds: [1, 10, 60][ctx.rng.int(0, 2)] }).toJSDate(), ctx),
      createdAt: at.toJSDate(),
    });
  }
  await ctx.prisma.webhookDelivery.deleteMany({ where: { url: { contains: 'mock.onebook.example' } } });
  const webhookDeliveries = await createManyBatched(ctx.prisma.webhookDelivery, rows);

  return { integrations: providers.length, webhookDeliveries };
}

// =========================================================================================
// Entry point
// =========================================================================================

export async function run(ctx: MockContext): Promise<Record<string, number>> {
  const mockVehicles = await ctx.prisma.vehicle.findMany({
    where: { unitNumber: { startsWith: MOCK_UNIT_PREFIX } },
    select: { id: true },
  });
  const mockVehicleIds = mockVehicles.map((v) => v.id);
  if (mockVehicleIds.length === 0) {
    throw new Error('reports: no mock vehicles found — run `core` first (see prisma/mock/README.md).');
  }

  const telemetryCount = await ctx.prisma.telemetryPoint.count({
    where: { vehicleId: { in: mockVehicleIds }, time: { gte: ctx.from, lte: ctx.to } },
  });
  if (telemetryCount === 0) {
    throw new Error(
      'reports: no mock TelemetryPoint rows in the 6-month window yet — the `ingest` generator ' +
        'must run and populate telemetry before IFTA segments can be computed from it. Run ' +
        '`npm run db:mock -- ingest` (or wait for it to finish) and re-run `reports`.',
    );
  }
  ctx.log(`reports: ${mockVehicleIds.length} mock vehicles, ${telemetryCount} mock telemetry points in window — proceeding`);

  const segmentUpserts = await computeIftaSegments(ctx, mockVehicleIds);
  const fuelPurchases = await generateFuelPurchases(ctx, mockVehicleIds);

  const mockUsers = await ctx.prisma.user.findMany({ where: { email: { endsWith: MOCK_EMAIL_DOMAIN } }, select: { id: true }, take: 30 });
  const seedRequesters = await ctx.prisma.user.findMany({
    where: { email: { in: ['sarah.chen@universal-logistics.example', 'carlos.ramirez@universal-logistics.example', 'amy.nguyen@universal-logistics.example'] } },
    select: { id: true },
  });
  const requesterIds = [...seedRequesters.map((u) => u.id), ...mockUsers.map((u) => u.id)];
  if (requesterIds.length === 0) {
    throw new Error('reports: no users found to attribute Report/ReportSchedule rows to — run `users` first.');
  }
  const { reports, schedules, realFiles } = await generateReportsAndSchedules(ctx, requesterIds);

  const rules = await generateAlertRules(ctx);
  const { deliveries, notifications } = await generateAlertDeliveriesAndNotifications(ctx, rules, mockVehicleIds);
  const { repointed: hosLinksRepointed, leftDangling: hosLinksDangling } = await repairOrphanedHosViolationLinks(ctx);

  const { integrations, webhookDeliveries } = await generateIntegrations(ctx);

  return {
    iftaSegmentUpserts: segmentUpserts,
    fuelPurchases,
    reports,
    reportSchedules: schedules,
    hosViolationLinksRepointed: hosLinksRepointed,
    hosViolationLinksDangling: hosLinksDangling,
    reportsWithRealFiles: realFiles,
    alertRules: rules.length,
    alertDeliveries: deliveries,
    notifications,
    integrations,
    webhookDeliveries,
  };
}
