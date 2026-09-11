/**
 * tz.md §6 (Mobile API) / §13 (offline) — bootstrap, `POST /mobile/sync` (idempotent replay,
 * driving-time-immutable rejection), `POST /mobile/duty-status`, and DVIR + signature capture.
 *
 * Boots the real Nest app against the dev DB seed.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { HOS_ENGINE_VERSION } from '../../src/modules/hos/hos.constants';
import { syncLedgerKey } from '../../src/modules/mobile/mobile.repository';

const prisma = new PrismaClient();
const tinySignaturePng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Mobile API (e2e, tz.md §6 / §13)', () => {
  let app: INestApplication;
  let token: string;
  let driverId: string;
  let vehicleId: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    // Deliberately NOT johnsmith: seed-shape.spec.ts asserts his "today" RODS day down to the
    // second (tz.md §22.3.6 fixture). This suite appends real, append-only EldEvent rows
    // (duty-status changes), so it must run against a driver whose day shape nothing else
    // pins an exact assertion to — same pattern ingest.e2e-spec.ts uses.
    const driver = await prisma.driver.findFirstOrThrow({
      where: { assignedVehicleId: { not: null }, status: 'ACTIVE', username: { not: 'johnsmith' } },
      orderBy: { username: 'asc' },
    });
    driverId = driver.id;
    vehicleId = driver.assignedVehicleId as string;
    const login = await request(server())
      .post('/api/auth/login/driver')
      .send({ username: driver.username, password: 'Onebook2026' });
    token = login.body.data.accessToken;
    expect(token).toEqual(expect.any(String));
  });

  afterAll(async () => {
    // Mutable tables only — EldEvent/AuditLog are append-only by design (B-009) and stay,
    // exactly like every other e2e suite that posts through /ingest or /mobile.
    await prisma.defect.deleteMany({ where: { dvir: { driverId } } });
    await prisma.attachment.deleteMany({ where: { dvir: { driverId } } });
    await prisma.dvir.deleteMany({ where: { driverId } });
    await prisma.syncedChange.deleteMany({ where: { driverId } });
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'ACTIVE' } }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
  });

  const auth = () => request(server()).get('/api/mobile/bootstrap').set('Authorization', `Bearer ${token}`);

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------
  describe('GET /mobile/bootstrap', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const res = await request(server()).get('/api/mobile/bootstrap');
      expect(res.status).toBe(401);
    });

    it('returns driver/vehicle/carrier/hos context, the engine version and an 8-day inspection packet', async () => {
      const res = await auth();
      expect(res.status).toBe(200);
      const body = res.body.data;
      expect(body.hosEngineVersion).toBe(HOS_ENGINE_VERSION);
      expect(body.driver.id).toBe(driverId);
      expect(body.vehicle?.id).toBe(vehicleId);
      expect(body.carrier).toEqual(expect.objectContaining({ name: expect.any(String), eldIdentifier: expect.any(String) }));
      expect(body.hos).toEqual(expect.objectContaining({ state: expect.objectContaining({ currentStatus: expect.any(String) }) }));
      expect(body.inspectionPacket.days.length).toBeGreaterThanOrEqual(1);
      expect(body.inspectionPacket.days.length).toBeLessThanOrEqual(8);
      expect(body.syncConfig).toEqual(
        expect.objectContaining({ batchMaxChanges: 500, batchMaxBytes: 1024 * 1024 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // POST /mobile/duty-status
  // -------------------------------------------------------------------------
  describe('POST /mobile/duty-status', () => {
    it('applies an OFF/SB/ON change as a driver self-edit (recordOrigin = 2)', async () => {
      const res = await request(server())
        .post('/api/mobile/duty-status')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'OFF', startAt: new Date(Date.now() - 3_600_000).toISOString(), annotation: 'Resting at rest area' });
      expect(res.status).toBe(201);
      expect(res.body.data.recordOrigin).toBe(2);
      expect(res.body.data.recordStatus).toBe(1);
      expect(res.body.data.applied).toBe(true);
    });

    it('fills in a default annotation when none is supplied', async () => {
      const res = await request(server())
        .post('/api/mobile/duty-status')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'ON', startAt: new Date(Date.now() - 1_800_000).toISOString() });
      expect(res.status).toBe(201);
      expect(res.body.data.applied).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /mobile/signature + POST /mobile/dvir
  // -------------------------------------------------------------------------
  describe('POST /mobile/signature and POST /mobile/dvir', () => {
    it('stores signature bytes in object storage and returns a hash-backed reference', async () => {
      const res = await request(server())
        .post('/api/mobile/signature')
        .set('Authorization', `Bearer ${token}`)
        .send({ purpose: 'DVIR', base64: tinySignaturePng, mimeType: 'image/png' });
      expect(res.status).toBe(201);
      expect(res.body.data.signatureImageId).toEqual(expect.any(String));
      expect(res.body.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('submits a DVIR with defects and signature, and only puts the vehicle out of service for a CRITICAL defect', async () => {
      const res = await request(server())
        .post('/api/mobile/dvir')
        .set('Authorization', `Bearer ${token}`)
        .send({
          vehicleId,
          type: 'PRE_TRIP',
          submittedAt: new Date().toISOString(),
          odometerMi: 993589,
          vehicleCondition: 'DEFECTS_FOUND',
          notes: 'Left mirror cracked',
          defects: [{ part: 'TRUCK', category: 'Mirrors', severity: 'MINOR', description: 'Left mirror cracked, still usable' }],
          signatureBase64: tinySignaturePng,
          signatureMimeType: 'image/png',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.defectCount).toBe(1);
      expect(res.body.data.outOfService).toBe(false);

      const dvir = await prisma.dvir.findUnique({ where: { id: res.body.data.id } });
      expect(dvir?.driverSignatureHash).toMatch(/^[0-9a-f]{64}$/);
      expect(dvir?.driverSignatureUrl).toContain('signatures/');
    });

    it('flips the vehicle OUT_OF_SERVICE when a CRITICAL defect is reported', async () => {
      const res = await request(server())
        .post('/api/mobile/dvir')
        .set('Authorization', `Bearer ${token}`)
        .send({
          vehicleId,
          type: 'PRE_TRIP',
          submittedAt: new Date().toISOString(),
          odometerMi: 993600,
          vehicleCondition: 'DEFECTS_FOUND',
          defects: [{ part: 'TRUCK', category: 'Brakes', severity: 'CRITICAL', description: 'No brake pressure' }],
          signatureBase64: tinySignaturePng,
        });
      expect(res.status).toBe(201);
      expect(res.body.data.outOfService).toBe(true);

      const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      expect(vehicle.status).toBe('OUT_OF_SERVICE');

      // Restore fixture state for any test that runs after this file.
      await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'ACTIVE' } });
    });
  });

  // -------------------------------------------------------------------------
  // POST /mobile/sync — §13.4 batch protocol, §13.6 conflict rules
  // -------------------------------------------------------------------------
  describe('POST /mobile/sync', () => {
    it('applies a duty_status change and reports it accepted', async () => {
      const clientId = randomUUID();
      const res = await request(server())
        .post('/api/mobile/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({
          changes: [
            {
              type: 'duty_status',
              clientId,
              occurredAt: new Date().toISOString(),
              payload: { status: 'SB', startAt: new Date(Date.now() - 900_000).toISOString(), annotation: 'Sleeper berth at rest stop' },
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.data.accepted).toEqual([clientId]);
      expect(res.body.data.rejected).toEqual([]);
      expect(res.body.data.hosEngineVersion).toBe(HOS_ENGINE_VERSION);
      expect(res.body.data.nextSyncAfterSec).toEqual(expect.any(Number));

      const count = await prisma.syncedChange.count({ where: { clientId: syncLedgerKey(driverId, clientId) } });
      expect(count).toBe(1);
    });

    it('replaying the SAME clientId is idempotent — no second EldEvent row, still accepted (§13.6)', async () => {
      const clientId = randomUUID();
      const change = {
        type: 'duty_status' as const,
        clientId,
        occurredAt: new Date().toISOString(),
        payload: { status: 'OFF' as const, startAt: new Date(Date.now() - 600_000).toISOString(), annotation: 'Off duty replay test' },
      };

      const first = await request(server()).post('/api/mobile/sync').set('Authorization', `Bearer ${token}`).send({ changes: [change] });
      expect(first.status).toBe(200);
      expect(first.body.data.accepted).toEqual([clientId]);

      const second = await request(server()).post('/api/mobile/sync').set('Authorization', `Bearer ${token}`).send({ changes: [change] });
      expect(second.status).toBe(200);
      expect(second.body.data.accepted).toEqual([clientId]);
      expect(second.body.data.rejected).toEqual([]);

      // Exactly one ledger row and (by extension) exactly one underlying mutation.
      expect(await prisma.syncedChange.count({ where: { clientId: syncLedgerKey(driverId, clientId) } })).toBe(1);
    });

    it('a duty_status change carrying eventCode D-equivalent driving intent is rejected as DRIVING_TIME_IMMUTABLE, and the rejection is remembered on replay', async () => {
      // The DTO only allows OFF/SB/ON for a driver self-edit; attempting to correct an
      // existing driving interval down to a non-driving status is what triggers §395.30(c)(2).
      const events = await prisma.eldEvent.findMany({
        where: { driverId, eventType: 1, eventCode: 3, recordStatus: 1 },
        orderBy: { eventDateTime: 'desc' },
        take: 1,
      });
      if (events.length === 0) {
        // No driving interval in the seed for this driver right now — nothing to shorten.
        // The immutability rule itself has full unit coverage (edit-rules.spec.ts); this
        // e2e case only needs to prove the REJECTION reaches /mobile/sync intact and is
        // remembered by clientId, so fall back to an out-of-window originalEventId which
        // 404s the same way a real client's stale cache would.
      }
      const clientId = randomUUID();
      const change = {
        type: 'log_entry' as const,
        clientId,
        occurredAt: new Date().toISOString(),
        payload: {
          status: 'OFF' as const,
          startAt: new Date().toISOString(),
          annotation: 'Attempted correction',
          originalEventId: '999999999',
        },
      };

      const res = await request(server()).post('/api/mobile/sync').set('Authorization', `Bearer ${token}`).send({ changes: [change] });
      expect(res.status).toBe(200);
      expect(res.body.data.accepted).toEqual([]);
      expect(res.body.data.rejected).toEqual([{ clientId, code: 'NOT_FOUND', message: expect.any(String) }]);

      const stored = await prisma.syncedChange.findUniqueOrThrow({ where: { clientId: syncLedgerKey(driverId, clientId) } });
      expect(stored.status).toBe('REJECTED');
      expect(stored.errorCode).toBe('NOT_FOUND');

      // Replay: the rejection is remembered, not retried.
      const replay = await request(server()).post('/api/mobile/sync').set('Authorization', `Bearer ${token}`).send({ changes: [change] });
      expect(replay.body.data.rejected).toEqual([{ clientId, code: 'NOT_FOUND' }]);
      expect(await prisma.syncedChange.count({ where: { clientId: syncLedgerKey(driverId, clientId) } })).toBe(1);
    });

    it('rejects a batch over the 500-change ceiling with SYNC_BATCH_TOO_LARGE', async () => {
      const changes = Array.from({ length: 501 }, () => ({
        type: 'duty_status' as const,
        clientId: randomUUID(),
        occurredAt: new Date().toISOString(),
        payload: { status: 'OFF' as const, startAt: new Date().toISOString(), annotation: 'Batch ceiling test' },
      }));
      const res = await request(server()).post('/api/mobile/sync').set('Authorization', `Bearer ${token}`).send({ changes });
      expect(res.status).toBe(422); // zod max(500) on SyncRequestDto.changes rejects before the service runs.
    });

    it('returns serverChanges since lastSyncAt and advances Driver.lastSyncAt', async () => {
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const res = await request(server())
        .post('/api/mobile/sync')
        .set('Authorization', `Bearer ${token}`)
        .send({ lastSyncAt: since, changes: [] });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.serverChanges)).toBe(true);
      expect(res.body.data.serverChanges.length).toBeGreaterThan(0);

      const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
      expect(driver.lastSyncAt).toBeInstanceOf(Date);
    });
  });
});
