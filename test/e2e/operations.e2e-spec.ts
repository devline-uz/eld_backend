/**
 * tz.md §11.5 / §14 (tasks.md Phase 10) — Trips dispatch, geofences, alert rules (incl.
 * the SMS 422 rejection) and the notification inbox. Boots the real Nest app against the
 * dev DB seed.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';

const prisma = new PrismaClient();

describe('Operations — trips / geofences / alert-rules / notifications (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let driverId: string;
  const server = () => app.getHttpServer();

  const createdTripIds: string[] = [];
  const createdGeofenceIds: string[] = [];
  const createdAlertRuleIds: string[] = [];

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

    // Deliberately NOT johnsmith — B-023 / seed-shape.spec.ts pins his exact RODS shape.
    const driver = await prisma.driver.findFirstOrThrow({
      where: { status: 'ACTIVE', username: { not: 'johnsmith' } },
      orderBy: { username: 'asc' },
    });
    driverId = driver.id;
  });

  afterAll(async () => {
    await prisma.tripStop.deleteMany({ where: { tripId: { in: createdTripIds } } });
    await prisma.trip.deleteMany({ where: { id: { in: createdTripIds } } });
    await prisma.geofence.deleteMany({ where: { id: { in: createdGeofenceIds } } });
    await prisma.alertRule.deleteMany({ where: { id: { in: createdAlertRuleIds } } });
    await app.close();
    await prisma.$disconnect();
  });

  it('creates a trip PLANNED, assigns a driver, and advances it through the lifecycle', async () => {
    const number = `E2E-TRIP-${Date.now()}`;
    const created = await request(server())
      .post('/api/trips')
      .set('Authorization', `Bearer ${token}`)
      .send({ number, commodity: 'General freight' });
    expect(created.status).toBe(201);
    const tripId = created.body.data.id as string;
    createdTripIds.push(tripId);
    expect(created.body.data.status).toBe('PLANNED');

    const assigned = await request(server())
      .post(`/api/trips/${tripId}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ driverId });
    expect(assigned.status).toBe(201);
    expect(assigned.body.data.status).toBe('ASSIGNED');

    const inProgress = await request(server())
      .patch(`/api/trips/${tripId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'IN_PROGRESS' });
    expect(inProgress.status).toBe(200);

    // Illegal transition: IN_PROGRESS -> ASSIGNED is not in ALLOWED_TRANSITIONS.
    const illegal = await request(server())
      .patch(`/api/trips/${tripId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ASSIGNED' });
    expect(illegal.status).toBe(409);
    expect(illegal.body.code).toBe('CONFLICT');
  });

  it('rejects a second trip on the same unit in an overlapping range (409 TRIP_SCHEDULE_CONFLICT), allows touching ranges', async () => {
    const vehicle = await prisma.vehicle.findFirstOrThrow({ where: { deletedAt: null }, orderBy: { unitNumber: 'asc' } });
    // A random far-future day so reruns and seed trips never collide.
    const base = Date.UTC(2031, 0, 1) + Math.floor(Math.random() * 3000) * 86_400_000;
    const hour = (h: number) => new Date(base + h * 3_600_000).toISOString();
    const post = (number: string, from: number, to: number) =>
      request(server())
        .post('/api/trips')
        .set('Authorization', `Bearer ${token}`)
        .send({ number, vehicleId: vehicle.id, plannedStartAt: hour(from), plannedEndAt: hour(to) });

    const first = await post(`E2E-UNIT-A-${Date.now()}`, 10, 14);
    expect(first.status).toBe(201);
    createdTripIds.push(first.body.data.id as string);

    const overlapping = await post(`E2E-UNIT-B-${Date.now()}`, 12, 16);
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.code).toBe('TRIP_SCHEDULE_CONFLICT');
    expect(overlapping.body.details.conflict.tripId).toBe(first.body.data.id);

    const touching = await post(`E2E-UNIT-C-${Date.now()}`, 14, 18);
    expect(touching.status).toBe(201);
    createdTripIds.push(touching.body.data.id as string);
  });

  it('draws a geofence and lists it back', async () => {
    const created = await request(server())
      .post('/api/geofences')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `E2E fence ${Date.now()}`, type: 'CIRCLE', centerLat: 40.0, centerLon: -83.0, radiusMi: 1, alertOnEnter: true });
    expect(created.status).toBe(201);
    createdGeofenceIds.push(created.body.data.id as string);

    const list = await request(server()).get('/api/geofences').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.items.some((g: { id: string }) => g.id === created.body.data.id)).toBe(true);
  });

  it('rejects an alert rule that selects the SMS channel with 422 CHANNEL_NOT_AVAILABLE', async () => {
    const res = await request(server())
      .post('/api/alert-rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        key: `e2e_sms_rule_${Date.now()}`,
        name: 'E2E SMS rule',
        severity: 'WARNING',
        conditions: [{ event: 'alert.e2e_test' }],
        channels: ['SMS'],
        recipients: { subjectDriver: true },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CHANNEL_NOT_AVAILABLE');
    expect(res.body.details).toEqual({ channel: 'SMS', availableIn: 'v2' });
  });

  it('creates an IN_APP-only alert rule successfully', async () => {
    const res = await request(server())
      .post('/api/alert-rules')
      .set('Authorization', `Bearer ${token}`)
      .send({
        key: `e2e_rule_${Date.now()}`,
        name: 'E2E rule',
        severity: 'INFO',
        conditions: [{ event: 'alert.e2e_test' }],
        channels: ['IN_APP'],
        recipients: { subjectDriver: true },
      });
    expect(res.status).toBe(201);
    createdAlertRuleIds.push(res.body.data.id as string);
  });

  it('lists the caller\'s own notification inbox', async () => {
    const res = await request(server()).get('/api/notifications').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({ items: expect.any(Array), page: 1, limit: 25 }),
    );
  });
});
