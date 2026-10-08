/**
 * docs/mobile-requests-2026-10-08.md — HTTP smoke for the read/stateless routes added by the
 * 2026-10-08 mobile requests: happy path + auth-denied path each (tz.md §21).
 *
 * Deliberately excludes `POST /mobile/release-vehicle` and the chat/support writes: they mutate
 * the driver's unit assignment / thread state that other suites pin exactly. Those are covered by
 * their service specs. Same driver pick as mobile.e2e-spec.ts (never johnsmith).
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { MobileRepository } from '../../src/modules/mobile/mobile.repository';
import { buildOutputFile } from '../../src/modules/transfers/output-file';
import { buildSnapshot } from '../../src/modules/transfers/snapshot';
import { TransfersRepository } from '../../src/modules/transfers/transfers.repository';

const prisma = new PrismaClient();
const tinySignaturePng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Mobile requests 2026-10-08 (e2e smoke)', () => {
  let app: INestApplication;
  let token: string;
  let driverId: string;
  let vehicleId: string;
  let loginAt: Date;
  const server = () => app.getHttpServer();
  const bearer = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const driver = await prisma.driver.findFirstOrThrow({
      where: { assignedVehicleId: { not: null }, status: 'ACTIVE', username: { not: 'johnsmith' } },
      orderBy: { username: 'asc' },
    });
    driverId = driver.id;
    vehicleId = driver.assignedVehicleId as string;
    loginAt = new Date();
    const login = await request(server())
      .post('/api/auth/login/driver')
      .send({ username: driver.username, password: 'Onebook2026' });
    token = login.body.data.accessToken;
    expect(token).toEqual(expect.any(String));
  });

  afterAll(async () => {
    await prisma.driverSavedSignature.deleteMany({ where: { driverId } });
    await prisma.driverDayDetails.deleteMany({ where: { driverId } });
    await app.close();
    await prisma.$disconnect();
  });

  describe('public routes (no token)', () => {
    it('GET /mobile/app-config answers without auth and exposes the version/store/legal keys', async () => {
      const res = await request(server()).get('/api/mobile/app-config?platform=android&appVersion=0.0.1');
      expect(res.status).toBe(200);
      // Unset config values are null by contract, so assert the keys exist, not that they are set.
      expect(Object.keys(res.body.data)).toEqual(
        expect.arrayContaining(['minSupportedVersion', 'latestVersion', 'storeUrl', 'privacyPolicyUrl', 'termsUrl']),
      );
    });

    it.each(['privacy', 'terms'])('GET /mobile/legal/%s returns a url pointer', async (kind) => {
      const res = await request(server()).get(`/api/mobile/legal/${kind}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(expect.objectContaining({ html: null }));
    });

    it('GET /mobile/legal/<unknown> is a 400', async () => {
      const res = await request(server()).get('/api/mobile/legal/cookies');
      expect(res.status).toBe(400);
    });
  });

  describe('driver-token routes', () => {
    const guarded: Array<[string, string]> = [
      ['GET', '/api/mobile/ping'],
      ['GET', '/api/mobile/defect-catalog'],
      ['GET', '/api/mobile/trailers'],
      ['GET', '/api/mobile/co-driver'],
      ['GET', '/api/mobile/saved-signature'],
      ['PUT', '/api/mobile/saved-signature'],
      ['DELETE', '/api/mobile/saved-signature'],
      ['GET', '/api/mobile/certification-status'],
      ['POST', '/api/mobile/release-vehicle'],
      ['POST', '/api/mobile/conversations'],
    ];
    it.each(guarded)('%s %s without a token is 401', async (method, path) => {
      const res = await (request(server()) as unknown as Record<string, (p: string) => request.Test>)[
        method.toLowerCase()
      ](path);
      expect(res.status).toBe(401);
    });

    it('GET /mobile/ping?bytes=64 returns exactly 64 raw bytes (not enveloped)', async () => {
      const res = await request(server())
        .get('/api/mobile/ping?bytes=64')
        .set(bearer())
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect((res.body as Buffer).length).toBe(64);
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('GET /mobile/defect-catalog lists TRUCK and TRAILER items; part filter narrows it', async () => {
      const all = await request(server()).get('/api/mobile/defect-catalog').set(bearer());
      expect(all.status).toBe(200);
      const parts = new Set((all.body.data as Array<{ part: string }>).map((r) => r.part));
      expect(parts).toEqual(new Set(['TRUCK', 'TRAILER']));
      const trailer = await request(server()).get('/api/mobile/defect-catalog?part=TRAILER').set(bearer());
      expect(trailer.status).toBe(200);
      expect((trailer.body.data as Array<{ part: string }>).every((r) => r.part === 'TRAILER')).toBe(true);
      expect(trailer.body.data[0]).toEqual(
        expect.objectContaining({ code: expect.any(String), name: expect.any(String), critical: expect.any(Boolean) }),
      );
    });

    it('GET /mobile/trailers returns an array of {id, number, plate}', async () => {
      const res = await request(server()).get('/api/mobile/trailers?limit=5').set(bearer());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeLessThanOrEqual(5);
    });

    it('GET /mobile/co-driver answers 200 (null when the driver is not paired)', async () => {
      const res = await request(server()).get('/api/mobile/co-driver').set(bearer());
      expect(res.status).toBe(200);
      expect(res.body.data === null || typeof res.body.data === 'object').toBe(true);
    });

    it('GET /mobile/certification-status?days=3 returns 3 days, oldest first', async () => {
      const res = await request(server()).get('/api/mobile/certification-status?days=3').set(bearer());
      expect(res.status).toBe(200);
      const days = res.body.data as Array<{ date: string; certified: boolean; recertificationRequired: boolean }>;
      expect(days).toHaveLength(3);
      expect([...days.map((d) => d.date)].sort()).toEqual(days.map((d) => d.date));
      expect(days[0]).toEqual(expect.objectContaining({ certified: expect.any(Boolean), recertificationRequired: expect.any(Boolean) }));
    });

    it('GET /mobile/certification-status rejects days=99 with 400/422', async () => {
      const res = await request(server()).get('/api/mobile/certification-status?days=99').set(bearer());
      expect([400, 422]).toContain(res.status);
    });

    it('saved-signature: GET -> PUT -> GET -> DELETE -> GET round-trip', async () => {
      await request(server()).delete('/api/mobile/saved-signature').set(bearer());
      const none = await request(server()).get('/api/mobile/saved-signature').set(bearer());
      expect(none.status).toBe(200);
      expect(none.body.data).toBeNull();

      const put = await request(server())
        .put('/api/mobile/saved-signature')
        .set(bearer())
        .send({ signatureBase64: tinySignaturePng, mimeType: 'image/png' });
      expect(put.status).toBe(200);
      expect(put.body.data).toEqual(
        expect.objectContaining({ signatureImageId: expect.any(String), url: expect.stringMatching(/^https?:/), mimeType: 'image/png' }),
      );

      const got = await request(server()).get('/api/mobile/saved-signature').set(bearer());
      expect(got.body.data.signatureImageId).toBe(put.body.data.signatureImageId);

      const del = await request(server()).delete('/api/mobile/saved-signature').set(bearer());
      expect([200, 204]).toContain(del.status);
      const after = await request(server()).get('/api/mobile/saved-signature').set(bearer());
      expect(after.body.data).toBeNull();
    });

    it('PUT /mobile/saved-signature rejects a body with neither bytes nor an id', async () => {
      const res = await request(server()).put('/api/mobile/saved-signature').set(bearer()).send({});
      expect([400, 422]).toContain(res.status);
    });
  });

  describe('mobile wave 4 (D-129 / D-130 / M-31)', () => {
    const loginRecords = () =>
      prisma.eldEvent.findMany({
        where: { driverId, eventType: 5, recordStatus: 1 },
        orderBy: [{ eventDateTime: 'desc' }, { eventSequenceId: 'desc' }],
      });

    it('D-130: logging in on an assigned unit leaves an open §395 login (eventType 5 code 1, origin 1) on it', async () => {
      const [latest] = await loginRecords();
      expect(latest).toEqual(expect.objectContaining({ eventCode: 1, vehicleId, recordOrigin: 1, recordStatus: 1 }));
    });

    it('D-130: a second login on the same unit writes no duplicate record', async () => {
      const before = (await loginRecords()).length;
      const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
      const again = await request(server()).post('/api/auth/login/driver').send({ username: driver.username, password: 'Onebook2026' });
      expect([200, 201]).toContain(again.status);
      expect((await loginRecords()).length).toBe(before);
    });

    it('D-117: delegation proof sees the server-written login on that unit', async () => {
      expect(await app.get(MobileRepository).findLoginVehicleAt(driverId, new Date())).toBe(vehicleId);
    });

    it('D-130: the eRODS ELD Login/Logout Report lists the server-written login under the driver username', async () => {
      const [driver, carrier] = await Promise.all([
        prisma.driver.findUniqueOrThrow({ where: { id: driverId } }),
        prisma.carrier.findFirstOrThrow(),
      ]);
      // The open login may predate this run (idempotent: an earlier run's login is still open).
      const [open] = await loginRecords();
      const from = new Date(Math.min(loginAt.getTime(), open.eventDateTime.getTime()) - 1_000);
      const events = await app.get(TransfersRepository).findEvents(driverId, from, new Date());
      const snapshot = buildSnapshot({
        driver,
        carrier,
        events,
        unidentifiedEvents: [],
        vehicles: await prisma.vehicle.findMany({ where: { id: vehicleId } }),
        users: [],
        dailyLogs: [],
        outputFileComment: 'e2e',
        generatedAt: new Date(),
        eldIdentifier: carrier.eldIdentifier,
        eldRegistrationId: carrier.eldRegistrationId ?? '',
        eldAuthenticationValue: 'E2E',
      });
      expect(snapshot.loginLogout?.some((row) => row.eventCode === 1)).toBe(true);
      const segment = buildOutputFile(snapshot).csv.split('ELD Login/Logout Report:')[1].split('CMV Engine Power-Up')[0];
      expect(segment).toContain(`,1,${driver.username},`);
    });

    it('M-31: GET /auth/me and /mobile/bootstrap expose the driver ELD username', async () => {
      const driver = await prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
      const me = await request(server()).get('/api/auth/me').set(bearer());
      expect(me.status).toBe(200);
      expect(me.body.data).toEqual(expect.objectContaining({ id: driverId, type: 'driver', username: driver.username }));
      const boot = await request(server()).get('/api/mobile/bootstrap').set(bearer());
      expect(boot.status).toBe(200);
      expect(boot.body.data.driver).toEqual(expect.objectContaining({ id: driverId, username: driver.username }));
    });

    it('D-129: GET /mobile/trip is never null; with no active trip PATCH stores free-text day details that GET /mobile/logs merges', async () => {
      const current = await request(server()).get('/api/mobile/trip').set(bearer());
      expect(current.status).toBe(200);
      expect(['TRIP', 'DAY_DETAILS']).toContain(current.body.data.source);
      if (current.body.data.source !== 'DAY_DETAILS') return; // this driver has a trip: PATCH would edit it

      const patch = await request(server())
        .patch('/api/mobile/trip')
        .set(bearer())
        .send({ trailerNumbers: ['zz-e2e-1'], shippingDocuments: ['BOL-E2E'] });
      expect(patch.status).toBe(200);
      expect(patch.body.data).toEqual(
        expect.objectContaining({ source: 'DAY_DETAILS', id: null, trailerNumbers: ['ZZ-E2E-1'], trailerId: null, shippingDocuments: ['BOL-E2E'] }),
      );
      const logDate = patch.body.data.logDate as string;

      const got = await request(server()).get(`/api/mobile/trip?date=${logDate}`).set(bearer());
      expect(got.body.data).toEqual(expect.objectContaining({ trailerNumbers: ['ZZ-E2E-1'], logDate }));

      const day = await request(server()).get(`/api/mobile/logs?date=${logDate}`).set(bearer());
      expect(day.status).toBe(200);
      expect(day.body.data.trip).toEqual(expect.objectContaining({ dayDetails: true }));
      expect(day.body.data.trip.trailerNumbers).toContain('ZZ-E2E-1');

      const bad = await request(server()).patch('/api/mobile/trip').set(bearer()).send({ trailerNumbers: ['HAS SPACE'] });
      expect(bad.status).toBe(422);
    });
  });
});
