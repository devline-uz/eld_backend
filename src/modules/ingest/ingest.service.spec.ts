import type { Device, Vehicle } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { computeChecksum } from './checksum';
import { DIAGNOSTIC, MALFUNCTION, RECORD_ORIGIN } from './event-codes';
import { IngestEventsDto } from './dto/ingest.dto';
import { IngestService } from './ingest.service';

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';
const DRIVER_ID = 'drv_john';

const device = { id: 'dev_1', serial: 'PT30_A86E', vehicleId: VEHICLE_ID, storedEventsCount: 0, lastSeenAt: null, bleState: 'CONNECTED' } as unknown as Device;
const vehicle = {
  id: VEHICLE_ID,
  odometerMi: 23_100,
  deviceOdometerMi: 5056,
  odometerOffsetMi: 18_044,
  odometerCalibratedAt: new Date('2025-01-01T00:00:00Z'),
} as unknown as Vehicle;

interface Captured {
  rows: Array<Record<string, unknown>>;
  segments: Array<Record<string, unknown>>;
  vehicleUpdates: Array<Record<string, unknown>>;
}

function makeService(overrides: Record<string, unknown> = {}): {
  service: IngestService;
  captured: Captured;
  repo: Record<string, jest.Mock>;
  alerts: string[];
  recalcJobs: Array<{ name: string; data: unknown }>;
  published: string[];
} {
  const captured: Captured = { rows: [], segments: [], vehicleUpdates: [] };
  const alerts: string[] = [];
  const recalcJobs: Array<{ name: string; data: unknown }> = [];
  const published: string[] = [];
  let sequence = 0;

  const repo: Record<string, jest.Mock> = {
    runInTransaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn({})),
    findDeviceBySerial: jest.fn(async () => device),
    findVehicle: jest.fn(async () => vehicle),
    findDriverAssignedVehicleId: jest.fn(async () => VEHICLE_ID),
    hasOpenSessionOnVehicle: jest.fn(async () => true),
    findExistingUuids: jest.fn(async () => new Set<string>()),
    findPcStateBefore: jest.fn(async () => false),
    findLastRawOdometerKm: jest.fn(async () => null),
    findSessionWindow: jest.fn(async () => ({
      openSessionDriverId: null,
      lastBefore: null,
      firstAfter: null,
    })),
    allocateSequenceIds: jest.fn(async (_tx: unknown, _key: string, count: number) =>
      Array.from({ length: count }, () => (sequence += 1)),
    ),
    ensurePartitions: jest.fn(async () => undefined),
    insertEvents: jest.fn(async (_tx: unknown, rows: Array<Record<string, unknown>>) => {
      captured.rows.push(...rows);
      return rows.length;
    }),
    findEventIdsByUuids: jest.fn(async () => [1n, 2n]),
    createUnidentifiedSegment: jest.fn(async (_tx: unknown, data: Record<string, unknown>) => {
      captured.segments.push(data);
      return { id: 'seg_1' };
    }),
    updateVehicle: jest.fn(async (_tx: unknown, _id: string, data: Record<string, unknown>) => {
      captured.vehicleUpdates.push(data);
      return vehicle;
    }),
    updateDevice: jest.fn(async () => device),
    updateDeviceOutsideTx: jest.fn(async () => device),
    collectWindowStats: jest.fn(async () => ({
      powerOffSec: 0,
      ecmSilenceSec: 0,
      noPositionSec: 0,
      unidentifiedDrivingSec: 0,
      powerDataMissing: false,
    })),
    findLoggedCodesInWindow: jest.fn(async () => new Set<string>()),
    ...(overrides as Record<string, jest.Mock>),
  };

  const telemetry = { store: jest.fn(async () => ({ accepted: 1, duplicates: 0, denserThanContract: 0 })) };
  const events = {
    publish: jest.fn(async (name: string) => {
      published.push(name);
      if (name.startsWith('alert.')) alerts.push(name);
    }),
  };
  const hosQueue = { add: jest.fn(async (name: string, data: unknown) => recalcJobs.push({ name, data })) };
  const alertQueue = { add: jest.fn(async () => undefined) };
  const safetyDetectQueue = { add: jest.fn(async () => undefined) };

  const service = new IngestService(
    repo as never,
    telemetry as never,
    events as never,
    hosQueue as never,
    alertQueue as never,
    safetyDetectQueue as never,
  );
  return { service, captured, repo, alerts, recalcJobs, published };
}

function batch(events: Array<Record<string, unknown>>): IngestEventsDto {
  return IngestEventsDto.parse({
    deviceSerial: 'PT30_A86E',
    vehicleId: VEHICLE_ID,
    batch: events,
  });
}

const baseEvent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  uuid: 'evt-0001',
  eventType: 1,
  eventCode: 3,
  eventDateTime: new Date().toISOString(),
  timezoneOffset: -240,
  recordOrigin: 1,
  latitude: 39.961176,
  longitude: -82.998794,
  rawDeviceOdometerKm: 8140,
  totalEngineHours: 1070.7,
  ...over,
});

const withChecksum = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const event = baseEvent(over);
  return {
    ...event,
    checksum: computeChecksum({
      uuid: event.uuid as string,
      eventType: event.eventType as number,
      eventCode: event.eventCode as number,
      eventDateTime: event.eventDateTime as string,
      timezoneOffset: event.timezoneOffset as number,
      recordOrigin: event.recordOrigin as number,
      recordStatus: (event.recordStatus as number) ?? 1,
      latitude: (event.latitude as number) ?? null,
      longitude: (event.longitude as number) ?? null,
      rawDeviceOdometerKm: (event.rawDeviceOdometerKm as number) ?? null,
      totalEngineHours: (event.totalEngineHours as number) ?? null,
    }),
  };
};

describe('IngestService — TZ §7', () => {
  describe('the payload is untrusted (§3.1: the app, not the device, calls us)', () => {
    it('rejects an unknown deviceSerial with 404', async () => {
      const { service } = makeService({ findDeviceBySerial: jest.fn(async () => null) });
      await expect(service.ingestEvents(batch([withChecksum()]), DRIVER_ID)).rejects.toThrow(
        AppException,
      );
    });

    it('rejects a vehicleId the device is not paired with', async () => {
      const { service } = makeService({
        findDeviceBySerial: jest.fn(async () => ({ ...device, vehicleId: 'other' })),
      });
      await expect(
        service.ingestEvents(batch([withChecksum()]), DRIVER_ID),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('rejects a driver who is neither assigned to the unit nor logged in on it', async () => {
      const { service } = makeService({
        findDriverAssignedVehicleId: jest.fn(async () => null),
        hasOpenSessionOnVehicle: jest.fn(async () => false),
      });
      await expect(
        service.ingestEvents(batch([withChecksum()]), DRIVER_ID),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it('§7.3 rule 1 — a duplicate uuid inserts nothing and is reported as a duplicate', async () => {
    const { service, captured } = makeService({
      findExistingUuids: jest.fn(async () => new Set(['evt-0001'])),
    });
    const result = await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
    expect(result.duplicates).toBe(1);
    expect(result.accepted).toBe(0);
    expect(captured.rows).toHaveLength(0);
  });

  it('§7.3 rule 4 — a bad checksum is stored anyway, with diagnostic 3 and a warning', async () => {
    const { service, captured } = makeService();
    const result = await service.ingestEvents(
      batch([baseEvent({ checksum: 'deadbeefdeadbeef' })]),
      DRIVER_ID,
    );
    expect(result.accepted).toBe(2); // the event + the generated diagnostic record
    expect(result.warnings[0].code).toBe('CHECKSUM_MISMATCH');
    expect(captured.rows[0].diagnosticCode).toBe(DIAGNOSTIC.MISSING_DATA);
    expect(result.diagnostics).toContain(DIAGNOSTIC.MISSING_DATA);
  });

  it('stores the server-computed checksum, so the record stays verifiable', async () => {
    const { service, captured } = makeService();
    await service.ingestEvents(batch([baseEvent({ checksum: 'deadbeefdeadbeef' })]), DRIVER_ID);
    expect(captured.rows[0].checksum).not.toBe('deadbeefdeadbeef');
    expect(captured.rows[0].checksum).toMatch(/^[0-9a-f]{16}$/);
  });

  it('§7.3 rule 5 — clock drift over 10 minutes stores the event, flags T, persists timeDriftSec', async () => {
    const { service, captured } = makeService();
    const at = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const result = await service.ingestEvents(
      batch([withChecksum({ eventDateTime: at })]),
      DRIVER_ID,
    );
    expect(captured.rows[0].malfunctionCode).toBe(MALFUNCTION.TIMING);
    expect(captured.rows[0].timeDriftSec as number).toBeGreaterThan(600);
    expect(result.warnings.some((w) => w.code === 'CLOCK_DRIFT')).toBe(true);
  });

  it('persists timeDriftSec even when the clock is fine', async () => {
    const { service, captured } = makeService();
    await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
    expect(captured.rows[0].timeDriftSec).toBeDefined();
    expect(captured.rows[0].malfunctionCode).toBeNull();
  });

  it('§7.3 rule 7 — totalVehicleMiles = kmToMi(raw) + offset, raw km kept for audit', async () => {
    const { service, captured } = makeService();
    await service.ingestEvents(batch([withChecksum({ rawDeviceOdometerKm: 8140 })]), DRIVER_ID);
    expect(captured.rows[0].rawDeviceOdometerKm).toBe(8140);
    expect(captured.rows[0].totalVehicleMiles).toBe(5058 + 18_044);
  });

  it('§4.3 — a backwards odometer raises diagnostic 3 and alert.odometer_anomaly', async () => {
    const { service, captured, alerts } = makeService({
      findLastRawOdometerKm: jest.fn(async () => 9000),
    });
    const result = await service.ingestEvents(
      batch([withChecksum({ rawDeviceOdometerKm: 8140 })]),
      DRIVER_ID,
    );
    expect(result.warnings.some((w) => w.code === 'ODOMETER_ANOMALY')).toBe(true);
    expect(captured.rows[0].diagnosticCode).toBe(DIAGNOSTIC.MISSING_DATA);
    expect(alerts).toContain('alert.odometer_anomaly');
  });

  it('§7.3 rule 9 — coordinates are coarsened before storage and the raw pair is never written', async () => {
    const { service, captured } = makeService();
    await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
    expect(captured.rows[0].latitude).not.toBe(39.961176);
    expect(captured.rows[0].longitude).not.toBe(-82.998794);
    expect(captured.rows[0].locationPrecisionMi).toBe(1);
  });

  it('§7.3 rule 9 — active Personal Conveyance coarsens to 10 miles', async () => {
    const { service, captured } = makeService({ findPcStateBefore: jest.fn(async () => true) });
    await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
    expect(captured.rows[0].locationPrecisionMi).toBe(10);
  });

  it('§7.3 rule 8 — every stored event gets a sequence id, assigned once at ingest', async () => {
    const { service, captured, repo } = makeService();
    await service.ingestEvents(
      batch([
        withChecksum({
          uuid: 'evt-aaaa-1',
          eventDateTime: new Date(Date.now() - 120_000).toISOString(),
        }),
        withChecksum({ uuid: 'evt-bbbb-2', eventDateTime: new Date().toISOString() }),
      ]),
      DRIVER_ID,
    );
    expect(repo.allocateSequenceIds).toHaveBeenCalledTimes(1);
    expect(captured.rows.map((r) => r.eventSequenceId)).toEqual([1, 2]);
  });

  it('§7.4 rule 1 — an open session owns device-stored events: origin 1, no segment', async () => {
    const { service, captured } = makeService({
      findSessionWindow: jest.fn(async () => ({
        openSessionDriverId: DRIVER_ID,
        lastBefore: null,
        firstAfter: null,
      })),
    });
    const result = await service.ingestEvents(
      batch([withChecksum({ wasStoredOnDevice: true })]),
      DRIVER_ID,
    );
    expect(captured.rows[0].driverId).toBe(DRIVER_ID);
    expect(captured.rows[0].recordOrigin).toBe(RECORD_ORIGIN.ELD_AUTOMATIC);
    expect(result.unidentifiedSegmentIds).toEqual([]);
    expect(captured.segments).toHaveLength(0);
  });

  it('§7.4 rule 2 — same driver either side of a short gap: origin stays 1, confirmation asked', async () => {
    const at = new Date().toISOString();
    const { captured, result } = await (async () => {
      const made = makeService({
        findSessionWindow: jest.fn(async () => ({
          openSessionDriverId: null,
          lastBefore: { driverId: DRIVER_ID, at: new Date(Date.now() - 20 * 60_000) },
          firstAfter: { driverId: DRIVER_ID, at: new Date(Date.now() + 20 * 60_000) },
        })),
      });
      const res = await made.service.ingestEvents(
        batch([withChecksum({ wasStoredOnDevice: true, eventDateTime: at })]),
        DRIVER_ID,
      );
      return { ...made, result: res };
    })();
    expect(captured.rows[0].recordOrigin).toBe(RECORD_ORIGIN.ELD_AUTOMATIC);
    expect(result.confirmationRequests).toEqual([DRIVER_ID]);
  });

  it('§7.4 rule 3 — unowned device-stored events become origin 4 + an UnidentifiedSegment', async () => {
    const { service, captured } = makeService();
    const result = await service.ingestEvents(
      batch([withChecksum({ wasStoredOnDevice: true })]),
      DRIVER_ID,
    );
    expect(captured.rows[0].driverId).toBeNull();
    expect(captured.rows[0].recordOrigin).toBe(RECORD_ORIGIN.UNIDENTIFIED);
    expect(result.unidentifiedSegmentIds).toEqual(['seg_1']);
    expect(captured.segments[0].fromStoredEvents).toBe(true);
  });

  it('never writes recordOrigin 2 — that value means genuinely driver-entered', async () => {
    const { service, captured } = makeService();
    await service.ingestEvents(
      batch([
        withChecksum({ uuid: 'evt-aaaa-3', wasStoredOnDevice: true }),
        withChecksum({ uuid: 'evt-bbbb-4', recordOrigin: 4 }),
      ]),
      DRIVER_ID,
    );
    expect(captured.rows.map((r) => r.recordOrigin)).not.toContain(RECORD_ORIGIN.DRIVER_ENTERED);
  });

  it('§7.3 rule 10 — a committed batch queues hos.recalc and pushes realtime', async () => {
    const { service, recalcJobs, published } = makeService();
    await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
    expect(recalcJobs[0].name).toBe('hos.recalc');
    expect(published).toContain('realtime.push');
  });

  it('§7.3 rule 6 — the whole batch goes through one transaction', async () => {
    const { service, repo } = makeService();
    await service.ingestEvents(
      batch([withChecksum({ uuid: 'evt-aaaa-5' }), withChecksum({ uuid: 'evt-bbbb-6' })]),
      DRIVER_ID,
    );
    expect(repo.runInTransaction).toHaveBeenCalledTimes(1);
    expect(repo.insertEvents).toHaveBeenCalledTimes(1);
  });

  it('calibrates the odometer offset on the first device reading (§4.3 step 2)', async () => {
    const { service, captured } = makeService({
      findVehicle: jest.fn(async () => ({ ...vehicle, odometerCalibratedAt: null, odometerOffsetMi: 0 })),
    });
    await service.ingestEvents(batch([withChecksum({ rawDeviceOdometerKm: 8140 })]), DRIVER_ID);
    // dash 23,100 − device 5,058 = 18,042
    expect(captured.vehicleUpdates[0].odometerOffsetMi).toBe(23_100 - 5058);
    expect(captured.rows[0].totalVehicleMiles).toBe(23_100);
  });
});

describe('IngestService — BLE state and device status (§7.6, §7.7)', () => {
  it('does not alert while the link is healthy', async () => {
    const { service, alerts } = makeService({
      findDeviceBySerial: jest.fn(async () => ({ ...device, lastSeenAt: new Date() })),
    });
    const result = await service.recordBleState(
      { deviceSerial: 'PT30_A86E', state: 'OUT_OF_RANGE' },
      DRIVER_ID,
    );
    expect(result.disconnectedAlert).toBe(false);
    expect(alerts).not.toContain('alert.eld_disconnected');
  });

  it('raises alert.eld_disconnected after 30 minutes without a connection', async () => {
    const { service, alerts } = makeService({
      findDeviceBySerial: jest.fn(async () => ({
        ...device,
        lastSeenAt: new Date(Date.now() - 45 * 60 * 1000),
      })),
    });
    const result = await service.recordBleState(
      { deviceSerial: 'PT30_A86E', state: 'DISCONNECTED' },
      DRIVER_ID,
    );
    expect(result.disconnectedAlert).toBe(true);
    expect(alerts).toContain('alert.eld_disconnected');
  });

  it('raises alert.device_backlog above 100 stored events and records the count', async () => {
    const { service, alerts, repo } = makeService();
    const result = await service.recordDeviceStatus(
      {
        deviceSerial: 'PT30_A86E',
        storedEventsCount: 142,
        recordsLost: false,
        consecutiveTransferFailures: 0,
        firmware: 'L113',
      },
      DRIVER_ID,
    );
    expect(result.backlogAlert).toBe(true);
    expect(alerts).toContain('alert.device_backlog');
    expect(repo.updateDeviceOutsideTx).toHaveBeenCalledWith(
      'dev_1',
      expect.objectContaining({ storedEventsCount: 142, firmware: 'L113' }),
    );
  });

  it('§7.8 R/S — device-reported record loss and transfer failures become logged codes', async () => {
    const { service } = makeService();
    const result = await service.recordDeviceStatus(
      {
        deviceSerial: 'PT30_A86E',
        storedEventsCount: 0,
        recordsLost: true,
        consecutiveTransferFailures: 3,
      },
      DRIVER_ID,
    );
    expect(result.codes).toEqual(
      expect.arrayContaining([`M:${MALFUNCTION.DATA_RECORDING}`, `M:${MALFUNCTION.DATA_TRANSFER}`]),
    );
  });
});
