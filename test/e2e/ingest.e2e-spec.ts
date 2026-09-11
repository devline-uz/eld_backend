/**
 * tz.md §7 — end-to-end ingest: simulated PT30 data posted by the APP with a DRIVER JWT
 * (§3.1: the device itself has no network) flows into partitioned `EldEvent` /
 * `TelemetryPoint` storage, with a checksum and a stable `eventSequenceId` on every record.
 *
 * Boots the real Nest app (full guard/interceptor chain) against the dev DB seed.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { computeChecksum } from '../../src/modules/ingest/checksum';

const prisma = new PrismaClient();

describe('Ingest (e2e, TZ §7)', () => {
  let app: INestApplication;
  let token: string;
  let vehicleId: string;
  let deviceSerial: string;
  let driverId: string;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    // A seeded driver who is assigned to a unit that has a PT30 paired to it.
    const drivers = await prisma.driver.findMany({
      where: { assignedVehicleId: { not: null }, status: 'ACTIVE' },
      orderBy: { username: 'asc' },
    });
    const devices = await prisma.device.findMany({
      where: { vehicleId: { in: drivers.map((d) => d.assignedVehicleId as string) } },
    });
    const device = devices[0];
    const driver = drivers.find((d) => d.assignedVehicleId === device.vehicleId)!;
    deviceSerial = device.serial;
    vehicleId = device.vehicleId!;
    driverId = driver.id;

    const login = await request(server())
      .post('/api/auth/login/driver')
      .send({ username: driver.username, password: 'Onebook2026' });
    token = login.body.data.accessToken;
    expect(token).toEqual(expect.any(String));
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const event = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const base = {
      uuid: randomUUID(),
      eventType: 1,
      eventCode: 4,
      eventDateTime: new Date().toISOString(),
      timezoneOffset: -240,
      recordStatus: 1,
      recordOrigin: 1,
      latitude: 39.961176,
      longitude: -82.998794,
      rawDeviceOdometerKm: 8140,
      totalEngineHours: 1070.7,
      ...over,
    };
    return {
      ...base,
      checksum: computeChecksum(base as never),
    };
  };

  it('rejects an unauthenticated call', async () => {
    const res = await request(server())
      .post('/api/ingest/events')
      .send({ deviceSerial, vehicleId, batch: [event()] });
    expect(res.status).toBe(401);
  });

  it('happy path: stores the batch, assigns sequence ids, answers 200', async () => {
    const body = { deviceSerial, vehicleId, sdkVersion: '6.7.1', batch: [event(), event()] };
    const res = await request(server())
      .post('/api/ingest/events')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBeGreaterThanOrEqual(2);
    expect(res.body.data.duplicates).toBe(0);

    const stored = await prisma.eldEvent.findFirst({
      where: { uuid: body.batch[0].uuid as string },
    });
    expect(stored).not.toBeNull();
    expect(stored!.eventSequenceId).toBeGreaterThanOrEqual(1);
    expect(stored!.eventSequenceId).toBeLessThanOrEqual(65_535);
    expect(stored!.checksum).toMatch(/^[0-9a-f]{16}$/);
    // §7.3 rule 9 — the raw coordinate is never stored.
    expect(Number(stored!.latitude)).not.toBe(39.961176);
    expect(stored!.locationPrecisionMi).toBe(1);
    // §7.3 rule 7 — imperial in the DB, raw metric preserved for audit.
    expect(stored!.rawDeviceOdometerKm).toBe(8140);
    expect(stored!.totalVehicleMiles).not.toBeNull();
  });

  it('§7.3 rule 1 — replaying the same uuid is idempotent (200, no new row)', async () => {
    const body = { deviceSerial, vehicleId, batch: [event()] };
    await request(server())
      .post('/api/ingest/events')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    const replay = await request(server())
      .post('/api/ingest/events')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(replay.status).toBe(200);
    expect(replay.body.data.duplicates).toBe(1);
    expect(replay.body.data.accepted).toBe(0);
    const rows = await prisma.eldEvent.count({ where: { uuid: body.batch[0].uuid as string } });
    expect(rows).toBe(1);
  });

  it('§7.3 rule 4 — a bad checksum is STORED and answered 202 ACCEPTED_WITH_WARNINGS', async () => {
    const bad = { ...event(), checksum: 'deadbeefdeadbeef' };
    const res = await request(server())
      .post('/api/ingest/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceSerial, vehicleId, batch: [bad] });

    expect(res.status).toBe(202);
    expect(res.body.data.warnings[0].code).toBe('CHECKSUM_MISMATCH');
    const stored = await prisma.eldEvent.findFirst({ where: { uuid: bad.uuid as string } });
    expect(stored).not.toBeNull();
    expect(stored!.diagnosticCode).toBe('3');
  });

  it('§7.3 rule 5 — a drifted device clock is stored, flagged T, drift persisted', async () => {
    const drifted = event({ eventDateTime: new Date(Date.now() + 25 * 60_000).toISOString() });
    const res = await request(server())
      .post('/api/ingest/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceSerial, vehicleId, batch: [drifted] });

    expect(res.status).toBe(202);
    const stored = await prisma.eldEvent.findFirst({ where: { uuid: drifted.uuid as string } });
    expect(stored!.malfunctionCode).toBe('T');
    expect(stored!.timeDriftSec).toBeGreaterThan(600);
  });

  it('rejects a schema violation with 422 — the only reason an event is ever refused', async () => {
    const res = await request(server())
      .post('/api/ingest/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceSerial, vehicleId, batch: [{ uuid: 'short' }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('§7.3 rule 2 — a batch over 500 events is a schema violation', async () => {
    const res = await request(server())
      .post('/api/ingest/events')
      .set('Authorization', `Bearer ${token}`)
      .send({
        deviceSerial,
        vehicleId,
        batch: Array.from({ length: 501 }, () => event()),
      });
    expect(res.status).toBe(422);
  });

  it('refuses a device the driver is not associated with (403)', async () => {
    const other = await prisma.device.findFirst({
      where: { vehicleId: { not: null, notIn: [vehicleId] } },
    });
    const res = await request(server())
      .post('/api/ingest/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceSerial: other!.serial, vehicleId: other!.vehicleId, batch: [event()] });
    expect(res.status).toBe(403);
  });

  it('POST /ingest/telemetry stores imperial, coarsened points (§5.6, §4.2)', async () => {
    const time = new Date();
    const res = await request(server())
      .post('/api/ingest/telemetry')
      .set('Authorization', `Bearer ${token}`)
      .send({
        deviceSerial,
        vehicleId,
        points: [
          {
            time: time.toISOString(),
            latitude: 39.961176,
            longitude: -82.998794,
            speedKmh: 105,
            odometerKm: 8140,
            coolantTempC: 88,
            isTransition: true,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(1);
    const point = await prisma.telemetryPoint.findFirst({
      where: { vehicleId, time },
    });
    expect(point!.speedMph).toBe(65);
    expect(point!.coolantTempC).toBe(88);
    expect(Number(point!.latitude)).not.toBe(39.961176);
  });

  it('POST /ingest/ble-state records the state (§7.6)', async () => {
    const res = await request(server())
      .post('/api/ingest/ble-state')
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceSerial, state: 'OUT_OF_RANGE' });
    expect(res.status).toBe(200);
    expect(res.body.data.bleState).toBe('OUT_OF_RANGE');
    const device = await prisma.device.findUnique({ where: { serial: deviceSerial } });
    expect(device!.bleState).toBe('OUT_OF_RANGE');
  });

  it('POST /ingest/device-status records the backlog and alerts over 100 (§7.7)', async () => {
    const res = await request(server())
      .post('/api/ingest/device-status')
      .set('Authorization', `Bearer ${token}`)
      .send({ deviceSerial, storedEventsCount: 142, firmware: 'L113' });
    expect(res.status).toBe(200);
    expect(res.body.data.backlogAlert).toBe(true);
    const device = await prisma.device.findUnique({ where: { serial: deviceSerial } });
    expect(device!.storedEventsCount).toBe(142);
  });

  it('every stored event for this driver has a checksum and a sequence id', async () => {
    const rows = await prisma.eldEvent.findMany({ where: { driverId }, take: 50 });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.checksum).not.toBe('');
      expect(row.eventSequenceId).toBeGreaterThanOrEqual(1);
    }
  });
});
