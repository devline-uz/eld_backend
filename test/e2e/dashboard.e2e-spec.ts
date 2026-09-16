/**
 * Perf plan item 3 — `GET /api/dashboard/summary` against the real dev DB. Asserts the
 * one-call aggregate answers what the 6 separate W-01 dashboard requests used to (live fleet,
 * 24h violations, pending unidentified driving, unread notification count, carrier basics,
 * vehicle counts) with a single round trip.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';

describe('Dashboard summary (e2e)', () => {
  let app: INestApplication;
  let token: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const login = await request(server())
      .post('/api/auth/login')
      .send({ email: 'sarah.chen@universal-logistics.example', password: 'Onebook2026' });
    token = login.body.data.accessToken as string;
    expect(token).toEqual(expect.any(String));
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers every dashboard sub-request in one response', async () => {
    const res = await request(server()).get('/api/dashboard/summary').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.liveFleet).toEqual(
      expect.objectContaining({
        items: expect.any(Array),
        generatedAt: expect.any(String),
        counts: expect.objectContaining({
          total: expect.any(Number),
          onDuty: expect.any(Number),
          moving: expect.any(Number),
          idle: expect.any(Number),
          offline: expect.any(Number),
        }),
      }),
    );
    expect(data.violations).toEqual(expect.objectContaining({ items: expect.any(Array), total: expect.any(Number) }));
    expect(data.unidentified).toEqual(expect.objectContaining({ total: expect.any(Number), totalDurationSec: expect.any(Number) }));
    expect(data.notifications).toEqual(expect.objectContaining({ unreadCount: expect.any(Number) }));
    expect(data.carrier).toEqual(expect.objectContaining({ id: 'carrier', name: expect.any(String) }));
    expect(data.vehicles).toEqual(expect.objectContaining({ active: expect.any(Number), total: expect.any(Number) }));
    expect(data.vehicles.total).toBeGreaterThanOrEqual(data.vehicles.active);
  });

  it('rejects without a token', async () => {
    const res = await request(server()).get('/api/dashboard/summary');
    expect(res.status).toBe(401);
  });
});
