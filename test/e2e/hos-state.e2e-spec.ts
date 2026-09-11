/**
 * tz.md §8.6 point 5 / §11.8 — `POST /mobile/hos-state`: the app posts the state ITS engine
 * computed, the server stores it in `DriverHosSnapshot`, compares it with its own calculation
 * and answers with the authoritative numbers. A payload from a different `HOS_ENGINE_VERSION`
 * is stored but NOT compared.
 *
 * Boots the real Nest app (full guard/interceptor chain) against the dev DB seed.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { HOS_ENGINE_VERSION } from '../../src/modules/hos/hos.constants';

const prisma = new PrismaClient();
const PATH = '/api/mobile/hos-state';

describe('Mobile HOS state (e2e, TZ §8.6)', () => {
  let app: INestApplication;
  let token: string;
  let driverId: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const driver = await prisma.driver.findFirstOrThrow({ where: { username: 'johnsmith' } });
    driverId = driver.id;
    const login = await request(server())
      .post('/api/auth/login/driver')
      .send({ username: driver.username, password: 'Onebook2026' });
    token = login.body.data.accessToken;
    expect(token).toEqual(expect.any(String));
  });

  afterAll(async () => {
    await prisma.driverHosSnapshot.deleteMany({ where: { driverId } });
    await app.close();
    await prisma.$disconnect();
  });

  const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    computedAt: new Date().toISOString(),
    hosEngineVersion: HOS_ENGINE_VERSION,
    appPlatform: 'ANDROID',
    state: {
      currentStatus: 'OFF',
      driveRemainingSec: 39600,
      shiftRemainingSec: 50400,
      breakRemainingSec: 28800,
      cycleRemainingSec: 252000,
      dailyTotals: { off: 0, sb: 0, drive: 0, on: 0 },
      violations: [],
    },
    ...over,
  });

  it('rejects an unauthenticated post with 401', async () => {
    const res = await request(server()).post(PATH).send(payload());
    expect(res.status).toBe(401);
  });

  it('rejects a malformed payload with 422', async () => {
    const res = await request(server())
      .post(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(payload({ state: { currentStatus: 'OFF' } }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('stores the app state and answers with the server engine version and its own state', async () => {
    const res = await request(server()).post(PATH).set('Authorization', `Bearer ${token}`).send(payload());
    expect(res.status).toBe(200);
    expect(res.body.data.hosEngineVersion).toBe(HOS_ENGINE_VERSION);
    expect(res.body.data.versionMismatch).toBe(false);
    expect(res.body.data.compared).toBe(true);
    expect(res.body.data.driftThresholdSec).toBe(60);
    expect(res.body.data.serverState).toEqual(
      expect.objectContaining({ currentStatus: expect.any(String), dailyTotals: expect.any(Object) }),
    );

    const snapshot = await prisma.driverHosSnapshot.findUnique({ where: { driverId } });
    expect(snapshot).toMatchObject({ hosEngineVersion: HOS_ENGINE_VERSION, appPlatform: 'ANDROID' });
    expect(snapshot?.lastComparedAt).toBeInstanceOf(Date);
    expect(snapshot?.maxDriftSec).toEqual(expect.any(Number));
  });

  it('keeps exactly one snapshot row per driver across repeated posts', async () => {
    await request(server()).post(PATH).set('Authorization', `Bearer ${token}`).send(payload());
    await request(server()).post(PATH).set('Authorization', `Bearer ${token}`).send(payload());
    expect(await prisma.driverHosSnapshot.count({ where: { driverId } })).toBe(1);
  });

  it('stores but does NOT compare a payload from another engine version (§8.6)', async () => {
    const res = await request(server())
      .post(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(payload({ hosEngineVersion: '0.0.1-old-app' }));
    expect(res.status).toBe(200);
    expect(res.body.data.versionMismatch).toBe(true);
    expect(res.body.data.compared).toBe(false);
    expect(res.body.data.drift).toBe(false);
    expect(res.body.data.maxDriftSec).toBeNull();
    expect(res.body.data.message).toContain('Update the app');

    const snapshot = await prisma.driverHosSnapshot.findUnique({ where: { driverId } });
    expect(snapshot?.hosEngineVersion).toBe('0.0.1-old-app');
    expect(snapshot?.lastComparedAt).toBeNull();
  });

  it('detects drift when the app posts counters far from the server', async () => {
    const res = await request(server())
      .post(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send(payload({ state: { ...(payload().state as object), driveRemainingSec: 1 } }));
    expect(res.status).toBe(200);
    expect(res.body.data.drift).toBe(true);
    expect(res.body.data.maxDriftSec).toBeGreaterThan(60);
    expect(res.body.data.fields.map((f: { field: string }) => f.field)).toContain('driveRemainingSec');

    const snapshot = await prisma.driverHosSnapshot.findUnique({ where: { driverId } });
    expect(snapshot?.driftAlerted).toBe(true);
  });
});
