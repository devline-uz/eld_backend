/** PT SDK 6.11 — `POST /ingest/device-events` (D-135). */
import type { Device, Vehicle } from '@prisma/client';
import { distanceMi } from '../../common/units';
import { harshSeverity, toRawEventRow, toSafetyEventRow } from './device-events.mapper';
import { DeviceEventsService } from './device-events.service';
import { IngestDeviceEventsDto } from './dto/ingest.dto';

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';
const DRIVER_ID = 'drv_john';

const device = {
  id: 'dev_1',
  serial: 'PT30_A86E',
  vehicleId: VEHICLE_ID,
  lastEventAt: null,
  harshAccelMg: 300,
  harshBrakeMg: 450,
  harshCornerMg: 0,
} as unknown as Device;
const vehicle = { id: VEHICLE_ID } as unknown as Vehicle;

function dto(events: Array<Record<string, unknown>>): IngestDeviceEventsDto {
  return IngestDeviceEventsDto.parse({ deviceSerial: 'PT30_A86E', vehicleId: VEHICLE_ID, events });
}

function setup(opts: { alreadyStored?: Array<{ occurredAt: string; seq: number }>; session?: Record<string, unknown> } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const safety: Array<Record<string, unknown>> = [];
  const deviceUpdates: Array<Record<string, unknown>> = [];
  const already = new Set((opts.alreadyStored ?? []).map((k) => `${new Date(k.occurredAt).getTime()}:${k.seq}`));
  const repo = {
    runInTransaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    findPcStateBefore: jest.fn(async () => false),
    findSessionWindow: jest.fn(async () => opts.session ?? { openSessionDriverId: null, lastBefore: null, firstAfter: null }),
    insertDeviceRawEvents: jest.fn(async (_tx: unknown, rows: Array<Record<string, unknown>>) => {
      const fresh = rows.filter((r) => !already.has(`${(r.occurredAt as Date).getTime()}:${r.seq as number}`));
      inserted.push(...fresh);
      return fresh.map((r, i) => ({ id: BigInt(i + 1), type: r.type, seq: r.seq, occurredAt: r.occurredAt }));
    }),
    insertSafetyEvents: jest.fn(async (_tx: unknown, rows: Array<Record<string, unknown>>) => {
      safety.push(...rows);
      return rows.length;
    }),
    updateDevice: jest.fn(async (_tx: unknown, _id: string, data: Record<string, unknown>) => {
      deviceUpdates.push(data);
      return device;
    }),
  };
  const ingest = { resolveContext: jest.fn(async () => ({ device, vehicle, driverId: DRIVER_ID })) };
  const published: Array<{ name: string; payload: unknown }> = [];
  const events = { publish: jest.fn(async (name: string, payload: unknown) => void published.push({ name, payload })) };
  const alertQueue = { add: jest.fn(async () => undefined) };
  const service = new DeviceEventsService(ingest as never, repo as never, events as never, alertQueue as never);
  return { service, repo, ingest, inserted, safety, deviceUpdates, published, alertQueue };
}

describe('DeviceEventsService — POST /ingest/device-events', () => {
  it('verifies device/unit/driver ownership through the shared ingest check', async () => {
    const { service, ingest } = setup();
    await service.ingestDeviceEvents(dto([{ type: 'EV_PERIODIC', seq: 1, occurredAt: '2026-10-10T12:00:00Z', live: true }]), DRIVER_ID);
    expect(ingest.resolveContext).toHaveBeenCalledWith('PT30_A86E', DRIVER_ID, VEHICLE_ID);
  });

  it('is idempotent on (occurredAt, seq): replays and in-payload repeats are duplicates, not rows', async () => {
    const { service, inserted } = setup({ alreadyStored: [{ occurredAt: '2026-10-10T12:00:00Z', seq: 1 }] });
    const result = await service.ingestDeviceEvents(
      dto([
        { type: 'EV_PERIODIC', seq: 1, occurredAt: '2026-10-10T12:00:00Z', live: true },
        { type: 'EV_PERIODIC', seq: 2, occurredAt: '2026-10-10T12:00:30Z', live: true },
        { type: 'EV_PERIODIC', seq: 2, occurredAt: '2026-10-10T12:00:30Z', live: true },
      ]),
      DRIVER_ID,
    );
    expect(result).toEqual({ received: 3, stored: 1, duplicates: 2, safetyEvents: 0 });
    expect(inserted).toHaveLength(1);
  });

  it('maps a new MEMS brake event to a HARSH_BRAKING SafetyEvent + alert.harsh_event', async () => {
    const { service, safety, alertQueue, published } = setup();
    const result = await service.ingestDeviceEvents(
      dto([{ type: 'EV_MEMS_BRK', seq: 7, occurredAt: '2026-10-10T12:03:10Z', live: true, speedKmh: 100, latitude: 41.8781, longitude: -87.6298 }]),
      DRIVER_ID,
    );
    expect(result.safetyEvents).toBe(1);
    expect(safety[0]).toMatchObject({ type: 'HARSH_BRAKING', driverId: DRIVER_ID, vehicleId: VEHICLE_ID, severity: 3, speedMph: 62, gForce: 0.45 });
    expect(alertQueue.add).toHaveBeenCalledWith('alert.harsh_event', expect.objectContaining({ type: 'HARSH_BRAKING', severity: 3 }));
    expect(published.map((p) => p.name)).toContain('realtime.push');
  });

  it('creates no SafetyEvent for a harsh event that was already stored', async () => {
    const { service, safety, alertQueue } = setup({ alreadyStored: [{ occurredAt: '2026-10-10T12:03:10Z', seq: 7 }] });
    const result = await service.ingestDeviceEvents(
      dto([{ type: 'EV_MEMS_BRK', seq: 7, occurredAt: '2026-10-10T12:03:10Z', live: true }]),
      DRIVER_ID,
    );
    expect(result.safetyEvents).toBe(0);
    expect(safety).toHaveLength(0);
    expect(alertQueue.add).not.toHaveBeenCalled();
  });

  it('a stored (not live) harsh event is attributed by the §7.4 ladder — unidentified = no driver', async () => {
    const { service, safety, repo } = setup();
    await service.ingestDeviceEvents(
      dto([{ type: 'EV_MEMS_ACC', seq: 3, occurredAt: '2026-10-10T03:00:00Z', live: false }]),
      DRIVER_ID,
    );
    expect(repo.findSessionWindow).toHaveBeenCalled();
    expect(safety[0]).toMatchObject({ type: 'HARSH_ACCEL', driverId: null, severity: 2 });
  });

  it('a stored harsh event inside an open session belongs to that session driver', async () => {
    const { service, safety } = setup({ session: { openSessionDriverId: 'drv_other', lastBefore: null, firstAfter: null } });
    await service.ingestDeviceEvents(
      dto([{ type: 'EV_MEMS_COR', seq: 3, occurredAt: '2026-10-10T03:00:00Z', live: false }]),
      DRIVER_ID,
    );
    // Cornering threshold 0 (off) yet the device reported one -> middle severity, no gForce.
    expect(safety[0]).toMatchObject({ type: 'HARSH_TURN', driverId: 'drv_other', severity: 3, gForce: null });
  });

  it('moves Device.lastEventAt forward only and stamps lastSeenAt', async () => {
    const { service, deviceUpdates } = setup();
    await service.ingestDeviceEvents(
      dto([
        { type: 'EV_PERIODIC', seq: 2, occurredAt: '2026-10-10T12:05:00Z', live: true },
        { type: 'EV_PERIODIC', seq: 1, occurredAt: '2026-10-10T12:00:00Z', live: true },
      ]),
      DRIVER_ID,
    );
    expect(deviceUpdates[0].lastEventAt).toEqual(new Date('2026-10-10T12:05:00Z'));
    expect(deviceUpdates[0].lastSeenAt).toBeInstanceOf(Date);
  });
});

describe('device-events.mapper', () => {
  const ctx = { deviceId: 'dev_1', vehicleId: VEHICLE_ID, driverId: DRIVER_ID, pcActive: false };
  const event = dto([{ type: 'EV_ENGINE_ON', seq: 1, occurredAt: '2026-10-10T12:00:00Z', live: true, latitude: 41.8781, longitude: -87.6298, speedKmh: 12.6 }]).events[0];

  it('coarsens coordinates before storage — the raw fix is never kept', () => {
    const row = toRawEventRow(event, ctx);
    expect(row.latitude).not.toBe(41.8781);
    expect(distanceMi({ lat: row.latitude as number, lon: row.longitude as number }, { lat: 41.8781, lon: -87.6298 })).toBeLessThanOrEqual(1);
    expect(row.speedKmh).toBe(13);
  });

  it('coarsens to 10 miles under Personal Conveyance', () => {
    const row = toRawEventRow(event, { ...ctx, pcActive: true });
    expect(distanceMi({ lat: row.latitude as number, lon: row.longitude as number }, { lat: 41.8781, lon: -87.6298 })).toBeLessThanOrEqual(10);
  });

  it('non-harsh rows never become SafetyEvents', () => {
    expect(toSafetyEventRow(toRawEventRow(event, ctx), device)).toBeNull();
  });

  it.each([
    [0, 3],
    [150, 1],
    [300, 2],
    [450, 3],
    [600, 4],
    [8192, 5],
  ])('threshold %p mG -> severity %p', (mg, severity) => {
    expect(harshSeverity(mg)).toBe(severity);
  });
});
