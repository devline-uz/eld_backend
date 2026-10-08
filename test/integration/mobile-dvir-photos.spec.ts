/**
 * mobile/tz.md §21 MB-6 (bugs.md) — `POST /mobile/dvir` / sync `dvir` used to DROP
 * `defects[].photoAttachmentIds`. Against the real dev DB: the DVIR_PHOTO upload leaves an
 * `Attachment` row, and `createDvir` links it to BOTH the Dvir and the right Defect in one
 * nested write. Fixtures are cleaned up so `seed-shape.spec.ts` keeps its counts.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../src/core/prisma/prisma.service';
import type { EventBusService } from '../../src/core/events/event-bus.service';
import { AuditRepository } from '../../src/modules/audit/audit.repository';
import { DvirPhotosRepository } from '../../src/modules/mobile/dvir-photos.repository';
import { MobileDvirService } from '../../src/modules/mobile/mobile-dvir.service';
import { MobileRepository } from '../../src/modules/mobile/mobile.repository';
import { MobileCatalogRepository } from '../../src/modules/mobile/mobile-catalog.repository';
import { SignatureService } from '../../src/modules/mobile/signature.service';

const prisma = new PrismaClient();
const prismaService = prisma as unknown as PrismaService;
const tag = randomUUID().slice(0, 8);

const storage = { put: jest.fn(async (key: string) => key), get: jest.fn(), delete: jest.fn() };
const eventBus = { publish: jest.fn(async () => undefined) } as unknown as EventBusService;
const alertQueue = { add: jest.fn(async () => ({})) };
const service = new MobileDvirService(
  new MobileRepository(prismaService),
  new DvirPhotosRepository(prismaService),
  new SignatureService(storage as never),
  new AuditRepository(prismaService),
  eventBus,
  alertQueue as never,
  new MobileCatalogRepository(prismaService),
);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let driverId: string;
let otherDriverId: string;
let vehicleId: string;
const dvirIds: string[] = [];

beforeAll(async () => {
  const vehicle = await prisma.vehicle.create({ data: { unitNumber: `DVP-${tag}`, vin: `VIN${tag}${tag}`.slice(0, 17), odometerMi: 1000 } });
  vehicleId = vehicle.id;
  const mk = (suffix: string) =>
    prisma.driver.create({
      data: { username: `dvp_${suffix}_${tag}`, passwordHash: 'x', firstName: 'Dvir', lastName: suffix, cdlNumber: `CDL${suffix}${tag}`, cdlState: 'KY', homeTerminalName: 'Florence', homeTerminalTimezone: 'America/New_York' },
    });
  driverId = (await mk('A')).id;
  otherDriverId = (await mk('B')).id;
}, 30_000);

afterAll(async () => {
  await prisma.attachment.deleteMany({ where: { uploadedById: { in: [driverId, otherDriverId] } } });
  await prisma.dvir.deleteMany({ where: { id: { in: dvirIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: [driverId, otherDriverId] } } });
  await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
  await prisma.$disconnect();
});

function submitDto(defects: Array<{ description: string; photoAttachmentIds: string[] }>) {
  return {
    vehicleId,
    type: 'PRE_TRIP' as const,
    submittedAt: new Date('2026-06-01T12:00:00Z'),
    odometerMi: 1000,
    vehicleCondition: 'DEFECTS_FOUND' as const,
    defects: defects.map((d) => ({ part: 'TRUCK' as const, category: 'Brakes', severity: 'MINOR' as const, ...d })),
    signatureBase64: PNG,
    signatureMimeType: 'image/png' as const,
  };
}

describe('MB-6 — DVIR photos persist on Defect/Attachment', () => {
  it('DVIR_PHOTO upload creates an Attachment row owned by the driver', async () => {
    const out = await service.uploadSignature(driverId, { purpose: 'DVIR_PHOTO', base64: PNG, mimeType: 'image/png' });
    const row = await prisma.attachment.findUnique({ where: { id: out.attachmentId! } });
    expect(row).toMatchObject({ key: out.key, sha256: out.sha256, uploadedById: driverId, uploadedByType: 'DRIVER', dvirId: null, defectId: null });
  });

  it('submit links each photo to its own defect and to the DVIR', async () => {
    const p1 = await service.uploadSignature(driverId, { purpose: 'DVIR_PHOTO', base64: PNG, mimeType: 'image/png' });
    const p2 = await service.uploadSignature(driverId, { purpose: 'DVIR_PHOTO', base64: PNG, mimeType: 'image/jpeg' });
    const p3 = await service.uploadSignature(driverId, { purpose: 'DVIR_PHOTO', base64: PNG, mimeType: 'image/png' });

    const out = await service.submit(
      driverId,
      submitDto([
        { description: 'left brake', photoAttachmentIds: [p1.attachmentId!, p2.attachmentId!] },
        { description: 'right mirror', photoAttachmentIds: [p3.attachmentId!] },
      ]),
      { id: driverId, type: 'driver' },
    );
    dvirIds.push(out.id);
    expect(out.photoCount).toBe(3);

    const defects = await prisma.defect.findMany({ where: { dvirId: out.id }, include: { photos: true } });
    const byDesc = Object.fromEntries(defects.map((d) => [d.description, d.photos.map((p) => p.id).sort()]));
    expect(byDesc).toEqual({ 'left brake': [p1.attachmentId, p2.attachmentId].sort(), 'right mirror': [p3.attachmentId] });
    const attachments = await prisma.attachment.findMany({ where: { id: { in: [p1.attachmentId!, p2.attachmentId!, p3.attachmentId!] } } });
    expect(attachments.every((a) => a.dvirId === out.id && a.defectId !== null)).toBe(true);
  });

  it("rejects another driver's photo and an already-attached photo with 422, creating nothing", async () => {
    const foreign = await service.uploadSignature(otherDriverId, { purpose: 'DVIR_PHOTO', base64: PNG, mimeType: 'image/png' });
    const attached = await prisma.attachment.findFirst({ where: { uploadedById: driverId, defectId: { not: null } } });
    const before = await prisma.dvir.count({ where: { driverId } });
    await expect(
      service.submit(driverId, submitDto([{ description: 'x', photoAttachmentIds: [foreign.attachmentId!, attached!.id] }]), { id: driverId, type: 'driver' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, details: { missing: expect.arrayContaining([foreign.attachmentId, attached!.id]) as string[] } });
    expect(await prisma.dvir.count({ where: { driverId } })).toBe(before);
  });
});
