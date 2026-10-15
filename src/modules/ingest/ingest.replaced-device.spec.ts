/**
 * D-163 — `/ingest/events` from a replaced device after the driver logged in on it again:
 * every record is stored (never rejected) and labelled; PT30 automatic records keep their status,
 * driver-entered duty records are stored inert (recordStatus 3). Kept apart from
 * `ingest.service.spec.ts` on purpose (that suite is owned by the ingest-device work).
 */
import type { Device, Vehicle } from '@prisma/client';
import { RequestContext } from '../../core/context/request-context';
import { IngestEventsDto } from './dto/ingest.dto';
import { IngestService } from './ingest.service';

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';
const DRIVER_ID = 'drv_john';
const device = { id: 'dev_1', serial: 'PT30_A86E', vehicleId: VEHICLE_ID, storedEventsCount: 0, lastSeenAt: null, bleState: 'CONNECTED' } as unknown as Device;
const vehicle = { id: VEHICLE_ID, odometerMi: 23_100, deviceOdometerMi: 5056, odometerOffsetMi: 18_044, odometerCalibratedAt: new Date('2025-01-01T00:00:00Z') } as unknown as Vehicle;

const REPLACED_AT = new Date(Date.now() - 6 * 3_600_000);
const LOGIN_AT = new Date(Date.now() - 3_600_000);

function makeService() {
  const rows: Array<Record<string, unknown>> = [];
  let sequence = 0;
  const repo = {
    runInTransaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    findDeviceBySerial: jest.fn(async () => device),
    findVehicle: jest.fn(async () => vehicle),
    findDriverAssignedVehicleId: jest.fn(async () => VEHICLE_ID),
    hasOpenSessionOnVehicle: jest.fn(async () => true),
    findAssociationState: jest.fn(async () => ({ holder: null, driverAssignedVehicleId: null, pairedDeviceId: 'dev_1', lastSession: null })),
    findExistingUuids: jest.fn(async () => new Set<string>()),
    findPcStateBefore: jest.fn(async () => false),
    findLastRawOdometerKm: jest.fn(async () => null),
    findSessionWindow: jest.fn(async () => ({ openSessionDriverId: null, lastBefore: null, firstAfter: null })),
    allocateSequenceIds: jest.fn(async (_tx: unknown, _key: string, count: number) => Array.from({ length: count }, () => (sequence += 1))),
    ensurePartitions: jest.fn(async () => undefined),
    insertEvents: jest.fn(async (_tx: unknown, data: Array<Record<string, unknown>>) => {
      rows.push(...data);
      return data.length;
    }),
    findEventIdsByUuids: jest.fn(async () => []),
    createUnidentifiedSegment: jest.fn(async () => ({ id: 'seg_1' })),
    updateVehicle: jest.fn(async () => vehicle),
    updateDevice: jest.fn(async () => device),
    updateDeviceOutsideTx: jest.fn(async () => device),
    collectWindowStats: jest.fn(async () => ({ powerOffSec: 0, ecmSilenceSec: 0, noPositionSec: 0, unidentifiedDrivingSec: 0, powerDataMissing: false })),
    findLoggedCodesInWindow: jest.fn(async () => new Set<string>()),
    findActiveCodes: jest.fn(async () => new Set<string>()),
    findCertifiedHeaders: jest.fn(async () => []),
    voidCertifications: jest.fn(async () => 0),
  };
  const replacedDevice = {
    contextFor: jest.fn(async () => ({ deviceId: 'phone-A', loginAt: LOGIN_AT, replaced: [{ revokedAt: REPLACED_AT, deviceLabel: 'Pixel 7' }] })),
  };
  const queue = { add: jest.fn(async () => undefined) };
  const service = new IngestService(
    repo as never,
    { store: jest.fn() } as never,
    { publish: jest.fn(async () => undefined) } as never,
    queue as never,
    queue as never,
    queue as never,
    { assertDeviceUsable: jest.fn(async () => undefined) } as never,
    replacedDevice as never,
  );
  return { service, rows, replacedDevice };
}

const event = (uuid: string, at: Date, over: Record<string, unknown> = {}) => ({
  uuid,
  eventType: 1,
  eventCode: 3,
  eventDateTime: at.toISOString(),
  timezoneOffset: -240,
  recordOrigin: 1,
  latitude: 39.961176,
  longitude: -82.998794,
  totalEngineHours: 1070.7,
  ...over,
});

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { requestId: 'r', traceId: 't', startedAt: Date.now(), user: { id: DRIVER_ID, type: 'driver', sessionId: 'sess-A2' } },
    fn,
  );
}

describe('D-163 — ingest from a replaced device', () => {
  it('stores and labels every record in the window; PT30 D stays active, a driver-entered status goes inert', async () => {
    const { service, rows, replacedDevice } = makeService();
    const inWindow = new Date(REPLACED_AT.getTime() + 3_600_000);
    const afterLogin = new Date(LOGIN_AT.getTime() + 60_000);
    const dto = IngestEventsDto.parse({
      deviceSerial: 'PT30_A86E',
      vehicleId: VEHICLE_ID,
      batch: [
        event('evt-drive', inWindow),
        event('evt-onduty', new Date(inWindow.getTime() + 600_000), { eventCode: 4, recordOrigin: 2 }),
        event('evt-afterlogin', afterLogin, { eventCode: 4, recordOrigin: 2 }),
      ],
    });

    const result = await run(() => service.ingestEvents(dto, DRIVER_ID));

    expect(replacedDevice.contextFor).toHaveBeenCalledWith(DRIVER_ID, 'sess-A2');
    expect(result.accepted).toBeGreaterThanOrEqual(3); // + a generated diagnostic is fine
    const byUuid = new Map(rows.map((row) => [row.uuid, row]));
    expect(byUuid.get('evt-drive')).toMatchObject({ recordStatus: 1, reviewReason: 'REPLACED_DEVICE', reviewDeviceLabel: 'Pixel 7' });
    expect(byUuid.get('evt-onduty')).toMatchObject({ recordStatus: 3, reviewReason: 'REPLACED_DEVICE', reviewDeviceLabel: 'Pixel 7' });
    expect(byUuid.get('evt-afterlogin')).toMatchObject({ recordStatus: 1, reviewReason: null, reviewDeviceLabel: null });
  });

  it('B-181 — a PT30 D claimed driver-origin is still origin 1 and never inactivated by the review', async () => {
    const { service, rows } = makeService();
    const inWindow = new Date(REPLACED_AT.getTime() + 3_600_000);
    const dto = IngestEventsDto.parse({
      deviceSerial: 'PT30_A86E',
      vehicleId: VEHICLE_ID,
      batch: [event('evt-drive-claim', inWindow, { recordOrigin: 2, recordStatus: 3 })],
    });
    await run(() => service.ingestEvents(dto, DRIVER_ID));
    const row = rows.find((r) => r.uuid === 'evt-drive-claim');
    expect(row).toMatchObject({ recordOrigin: 1, recordStatus: 1, reviewReason: 'REPLACED_DEVICE' });
  });
});
