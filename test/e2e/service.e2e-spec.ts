/**
 * tz.md §5.10 (tasks.md Phase 7) — DVIR web read/review, defect resolution, work orders,
 * maintenance scheduling, and DTC capture. Boots the real Nest app against the dev DB seed.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authenticator } from 'otplib';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';

const prisma = new PrismaClient();

describe('DVIR / Service (e2e, tz.md §5.10)', () => {
  let app: INestApplication;
  let token: string;
  let driverId: string;
  let vehicleId: string;
  const server = () => app.getHttpServer();

  const createdDvirIds: string[] = [];
  const createdDefectIds: string[] = [];
  const createdWorkOrderIds: string[] = [];
  const createdScheduleIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const login = await request(server())
      .post('/api/auth/login')
      .send({ email: 'sarah.chen@universal-logistics.example', password: 'Onebook2026' });
    const sarah = await prisma.user.findUnique({ where: { email: 'sarah.chen@universal-logistics.example' } });
    const code = authenticator.generate(sarah!.twoFactorSecret!);
    const verified = await request(server())
      .post('/api/auth/2fa/verify')
      .send({ pendingTwoFactorToken: login.body.data.pendingTwoFactorToken, code });
    token = verified.body.data.accessToken as string;
    expect(token).toEqual(expect.any(String));

    // Deliberately NOT johnsmith — B-023 / seed-shape.spec.ts pins his exact RODS shape.
    // A paired device is required for the ingest/telemetry DTC-capture case below.
    const driver = await prisma.driver.findFirstOrThrow({
      where: {
        assignedVehicleId: { not: null },
        status: 'ACTIVE',
        username: { not: 'johnsmith' },
        assignedVehicle: { device: { isNot: null } },
      },
      orderBy: { username: 'asc' },
    });
    driverId = driver.id;
    vehicleId = driver.assignedVehicleId as string;
  });

  // Every `it()` in this suite is independent: a prior test's still-open CRITICAL defect
  // (e.g. "lists the DVIR..." never resolves the one it seeds) would otherwise block the
  // out-of-service restore assertion in a later test. Resolve and restore between tests.
  afterEach(async () => {
    await prisma.defect.updateMany({
      where: { vehicleId, status: 'OPEN', severity: 'CRITICAL' },
      data: { status: 'REPAIRED', resolvedAt: new Date() },
    });
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'ACTIVE' } }).catch(() => undefined);
  });

  afterAll(async () => {
    await prisma.attachment.deleteMany({ where: { dvirId: { in: createdDvirIds } } });
    await prisma.defect.deleteMany({ where: { OR: [{ id: { in: createdDefectIds } }, { dvirId: { in: createdDvirIds } }] } });
    await prisma.workOrder.deleteMany({ where: { id: { in: createdWorkOrderIds } } });
    await prisma.maintenanceSchedule.deleteMany({ where: { id: { in: createdScheduleIds } } });
    await prisma.dvir.deleteMany({ where: { id: { in: createdDvirIds } } });
    await prisma.diagnosticTroubleCode.deleteMany({ where: { vehicleId } });
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'ACTIVE' } }).catch(() => undefined);
    await app.close();
    await prisma.$disconnect();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function seedDvirWithCriticalDefect() {
    const dvir = await prisma.dvir.create({
      data: {
        driverId,
        vehicleId,
        type: 'PRE_TRIP',
        submittedAt: new Date(),
        odometerMi: 1000,
        vehicleCondition: 'DEFECTS_FOUND',
        driverSignatureUrl: `signatures/${driverId}/${randomUUID()}.png`,
      },
    });
    createdDvirIds.push(dvir.id);
    const defect = await prisma.defect.create({
      data: {
        dvirId: dvir.id,
        vehicleId,
        category: 'Brakes, Service',
        part: 'TRUCK',
        severity: 'CRITICAL',
        description: 'Service brake failing to hold on grade.',
        outOfService: true,
      },
    });
    createdDefectIds.push(defect.id);
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'OUT_OF_SERVICE' } });
    return { dvir, defect };
  }

  // ---------------------------------------------------------------------
  // Auth rejection
  // ---------------------------------------------------------------------
  it('rejects unauthenticated requests with 401 on every new route family', async () => {
    for (const path of ['/api/dvir', '/api/defects', '/api/work-orders', '/api/maintenance-schedules', `/api/vehicles/${vehicleId}/dtc`]) {
      const res = await request(server()).get(path);
      expect(res.status).toBe(401);
    }
  });

  // ---------------------------------------------------------------------
  // DVIR read + mechanic sign-off
  // ---------------------------------------------------------------------
  describe('GET /dvir, mechanic sign-off', () => {
    it('lists the DVIR and returns its defects on GET /dvir/:id', async () => {
      const { dvir } = await seedDvirWithCriticalDefect();

      const list = await request(server()).get('/api/dvir').query({ vehicleId }).set(auth());
      expect(list.status).toBe(200);
      expect(list.body.data.items.some((d: { id: string }) => d.id === dvir.id)).toBe(true);

      const detail = await request(server()).get(`/api/dvir/${dvir.id}`).set(auth());
      expect(detail.status).toBe(200);
      expect(detail.body.data.defects).toHaveLength(1);
    });

    it('records a mechanic sign-off', async () => {
      const { dvir } = await seedDvirWithCriticalDefect();
      const res = await request(server())
        .post(`/api/dvir/${dvir.id}/mechanic-signoff`)
        .set(auth())
        .send({ mechanicName: 'J. Alvarez', repairStatus: 'REPAIRED', mechanicNote: 'Replaced pads' });
      expect(res.status).toBe(201);
      expect(res.body.data.mechanicName).toBe('J. Alvarez');
      expect(res.body.data.repairStatus).toBe('REPAIRED');
    });

    it('404s for an unknown DVIR', async () => {
      const res = await request(server()).get(`/api/dvir/${randomUUID()}`).set(auth());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('DVIR_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------
  // Defect resolution restores the vehicle from OUT_OF_SERVICE
  // ---------------------------------------------------------------------
  describe('PATCH /defects/:id/resolve — TZ §5.10 out-of-service rule', () => {
    it('restores the vehicle to ACTIVE once the last open CRITICAL defect is resolved', async () => {
      const { defect } = await seedDvirWithCriticalDefect();

      const before = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      expect(before.status).toBe('OUT_OF_SERVICE');

      const res = await request(server())
        .patch(`/api/defects/${defect.id}/resolve`)
        .set(auth())
        .send({ status: 'REPAIRED', resolutionNote: 'Brakes replaced and re-tested.' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REPAIRED');

      const after = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
      expect(after.status).toBe('ACTIVE');
    });
  });

  // ---------------------------------------------------------------------
  // Work orders — defect resolution workflow tied to a work order
  // ---------------------------------------------------------------------
  describe('Work orders (TZ §5.10 "Create work order" screen)', () => {
    it('creates a work order, attaches a defect, refuses to close until resolved, then closes', async () => {
      const { defect } = await seedDvirWithCriticalDefect();

      const created = await request(server())
        .post('/api/work-orders')
        .set(auth())
        .send({ vehicleId, title: 'Brake service', priority: 'HIGH', defectIds: [defect.id] });
      expect(created.status).toBe(201);
      expect(created.body.data.number).toMatch(/^WO-\d{4}$/);
      const workOrderId = created.body.data.id as string;
      createdWorkOrderIds.push(workOrderId);

      const linked = await prisma.defect.findUniqueOrThrow({ where: { id: defect.id } });
      expect(linked.workOrderId).toBe(workOrderId);

      const blockedClose = await request(server()).post(`/api/work-orders/${workOrderId}/close`).set(auth());
      expect(blockedClose.status).toBe(409);
      expect(blockedClose.body.code).toBe('DEFECT_NOT_RESOLVED');

      const resolve = await request(server()).patch(`/api/defects/${defect.id}/resolve`).set(auth()).send({ status: 'REPAIRED' });
      expect(resolve.status).toBe(200);

      const closed = await request(server()).post(`/api/work-orders/${workOrderId}/close`).set(auth());
      expect(closed.status).toBe(201);
      expect(closed.body.data.status).toBe('DONE');

      const reopenAttempt = await request(server()).patch(`/api/work-orders/${workOrderId}`).set(auth()).send({ title: 'Should fail' });
      expect(reopenAttempt.status).toBe(409);
      expect(reopenAttempt.body.code).toBe('WORK_ORDER_CLOSED');
    });
  });

  // ---------------------------------------------------------------------
  // Maintenance schedules — interval-by-mileage due/overdue detection
  // ---------------------------------------------------------------------
  describe('Maintenance schedules', () => {
    it('creates a schedule, computes overdue, and completing it resets the interval clock', async () => {
      const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });

      const created = await request(server())
        .post('/api/maintenance-schedules')
        .set(auth())
        .send({ vehicleId, name: 'Oil change', intervalMi: 1, lastServiceMi: Math.max(vehicle.odometerMi - 100, 0) });
      expect(created.status).toBe(201);
      const scheduleId = created.body.data.id as string;
      createdScheduleIds.push(scheduleId);

      const get = await request(server()).get(`/api/maintenance-schedules/${scheduleId}`).set(auth());
      expect(get.status).toBe(200);
      expect(get.body.data.due.state).toBe('OVERDUE');

      const dueList = await request(server()).get('/api/maintenance-schedules').query({ vehicleId, dueOnly: 'true' }).set(auth());
      expect(dueList.status).toBe(200);
      expect(dueList.body.data.items.some((s: { id: string }) => s.id === scheduleId)).toBe(true);

      const completed = await request(server()).post(`/api/maintenance-schedules/${scheduleId}/complete`).set(auth()).send({});
      expect(completed.status).toBe(201);
      expect(completed.body.data.lastServiceMi).toBeGreaterThanOrEqual(vehicle.odometerMi);
    });
  });

  // ---------------------------------------------------------------------
  // DTC surfaced on the vehicle
  // ---------------------------------------------------------------------
  describe('GET /vehicles/:id/dtc', () => {
    it('lists DTCs captured for the unit', async () => {
      await prisma.diagnosticTroubleCode.create({
        data: { vehicleId, spn: 100, fmi: 1, source: '0', description: 'Oil pressure low', firstSeenAt: new Date(), lastSeenAt: new Date() },
      });

      const res = await request(server()).get(`/api/vehicles/${vehicleId}/dtc`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.items.some((d: { spn: number; fmi: number }) => d.spn === 100 && d.fmi === 1)).toBe(true);
    });

    it('404s for an unknown vehicle', async () => {
      const res = await request(server()).get(`/api/vehicles/${randomUUID()}/dtc`).set(auth());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('VEHICLE_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------
  // DTC capture from the ingest/telemetry path (TZ §5.7)
  // ---------------------------------------------------------------------
  describe('DTC capture from POST /ingest/telemetry', () => {
    it('persists a per-code DTC from a telemetry point and surfaces it', async () => {
      const driverLogin = await request(server())
        .post('/api/auth/login/driver')
        .send({ username: (await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).username, password: 'Onebook2026' });
      const driverToken = driverLogin.body.data.accessToken as string;

      const device = await prisma.device.findUniqueOrThrow({ where: { vehicleId } });
      const res = await request(server())
        .post('/api/ingest/telemetry')
        .set('Authorization', `Bearer ${driverToken}`)
        .send({
          deviceSerial: device.serial,
          vehicleId,
          points: [
            {
              time: new Date().toISOString(),
              latitude: 39.9,
              longitude: -83.0,
              dtcCodes: [{ spn: 5246, fmi: 0, source: '0', description: 'Engine exhaust — aftertreatment' }],
              isTransition: true,
            },
          ],
        });
      expect(res.status).toBe(200);

      const dtcList = await request(server()).get(`/api/vehicles/${vehicleId}/dtc`).set(auth());
      expect(dtcList.body.data.items.some((d: { spn: number; fmi: number }) => d.spn === 5246 && d.fmi === 0)).toBe(true);
    });
  });
});
