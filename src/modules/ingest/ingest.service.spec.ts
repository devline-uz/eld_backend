import type { Device, Vehicle } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { computeChecksum } from './checksum';
import { DIAGNOSTIC, MALFUNCTION, RECORD_ORIGIN } from './event-codes';
import { IngestBleStateDto, IngestDeviceStatusDto, IngestEventsDto, IngestTelemetryDto } from './dto/ingest.dto';
import { VirtualEldPolicy } from '../carrier/virtual-eld.policy';
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
  events: { publish: jest.Mock<Promise<void>, [string, unknown?]> };
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
    // D-164 — fresh re-read on a miss; default = nothing conflicts (unit free, device on it).
    findAssociationState: jest.fn(async () => ({
      holder: null,
      driverAssignedVehicleId: null,
      pairedDeviceId: 'dev_1',
      lastSession: null,
    })),
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
    findActiveCodes: jest.fn(async () => new Set<string>()),
    findCertifiedHeaders: jest.fn(async () => []),
    voidCertifications: jest.fn(async (_tx: unknown, ids: string[]) => ids.length),
    ...(overrides as Record<string, jest.Mock>),
  };

  const telemetry = { store: jest.fn(async () => ({ accepted: 1, duplicates: 0, denserThanContract: 0 })) };
  const events = {
    publish: jest.fn(async (name: string, _payload?: unknown) => {
      published.push(name);
      if (name.startsWith('alert.')) alerts.push(name);
    }),
  };
  const hosQueue = { add: jest.fn(async (name: string, data: unknown) => recalcJobs.push({ name, data })) };
  const alertQueue = { add: jest.fn(async () => undefined) };
  const safetyDetectQueue = { add: jest.fn(async () => undefined) };
  // pt30_pt40/tz.md §9.3 — pass-through gate unless a test injects the real policy.
  const virtualEld = (overrides.virtualEld as object | undefined) ?? { assertDeviceUsable: jest.fn(async () => undefined) };

  const service = new IngestService(
    repo as never,
    telemetry as never,
    events as never,
    hosQueue as never,
    alertQueue as never,
    safetyDetectQueue as never,
    virtualEld as never,
  );
  return { service, captured, repo, alerts, recalcJobs, published, events };
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

    it('rejects a driver who is neither assigned to the unit nor logged in on it (unit held by another driver)', async () => {
      const { service } = makeService({
        findDriverAssignedVehicleId: jest.fn(async () => null),
        hasOpenSessionOnVehicle: jest.fn(async () => false),
        findAssociationState: jest.fn(async () => ({
          holder: { id: 'drv_other', status: 'ACTIVE' },
          driverAssignedVehicleId: null,
          pairedDeviceId: 'dev_1',
          lastSession: null,
        })),
      });
      await expect(
        service.ingestEvents(batch([withChecksum()]), DRIVER_ID),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', details: { reason: 'UNIT_ASSIGNED_TO_ANOTHER_DRIVER' } });
    });

    describe('D-164 — transient "assignment not visible yet" is 503 + retryAfterSec, never 4xx', () => {
      const noAssoc = { findDriverAssignedVehicleId: jest.fn(async () => null), hasOpenSessionOnVehicle: jest.fn(async () => false) };

      it('driver unassigned, unit free, no logout from it -> 503 INGEST_ASSIGNMENT_PENDING, nothing written', async () => {
        const { service, repo } = makeService(noAssoc);
        await expect(service.ingestEvents(batch([withChecksum()]), DRIVER_ID)).rejects.toMatchObject({
          status: 503,
          code: 'INGEST_ASSIGNMENT_PENDING',
          details: { pending: ['DRIVER_ASSIGNMENT'], retryAfterSec: 30 },
        });
        expect(repo.runInTransaction).not.toHaveBeenCalled();
      });

      it('the fresh re-read sees the assignment landed meanwhile -> accepted', async () => {
        const { service, captured } = makeService({
          ...noAssoc,
          findAssociationState: jest.fn(async () => ({
            holder: { id: DRIVER_ID, status: 'ACTIVE' }, driverAssignedVehicleId: VEHICLE_ID, pairedDeviceId: 'dev_1', lastSession: null,
          })),
        });
        await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
        expect(captured.rows).toHaveLength(1);
      });

      it('a logout from the unit within 10 min -> 503; older than 10 min -> 403 DRIVER_LEFT_UNIT', async () => {
        const at = (ms: number) => ({
          ...noAssoc,
          findAssociationState: jest.fn(async () => ({
            holder: null, driverAssignedVehicleId: null, pairedDeviceId: 'dev_1',
            lastSession: { eventCode: 2, eventDateTime: new Date(Date.now() - ms) },
          })),
        });
        await expect(makeService(at(60_000)).service.ingestEvents(batch([withChecksum()]), DRIVER_ID)).rejects.toMatchObject({ status: 503 });
        await expect(makeService(at(11 * 60_000)).service.ingestEvents(batch([withChecksum()]), DRIVER_ID)).rejects.toMatchObject({
          status: 403, details: { reason: 'DRIVER_LEFT_UNIT' },
        });
      });

      it('driver now assigned to another unit -> 403 DRIVER_ASSIGNED_TO_ANOTHER_UNIT', async () => {
        const { service } = makeService({
          ...noAssoc,
          findAssociationState: jest.fn(async () => ({ holder: null, driverAssignedVehicleId: 'veh_other', pairedDeviceId: 'dev_1', lastSession: null })),
        });
        await expect(service.ingestEvents(batch([withChecksum()]), DRIVER_ID)).rejects.toMatchObject({
          status: 403, details: { reason: 'DRIVER_ASSIGNED_TO_ANOTHER_UNIT' },
        });
      });

      it('unpaired device claiming a free unit -> 503 pending DEVICE_PAIRING (telemetry + device-events share it)', async () => {
        const { service } = makeService({
          findDeviceBySerial: jest.fn(async () => ({ ...device, vehicleId: null })),
          findAssociationState: jest.fn(async () => ({ holder: null, driverAssignedVehicleId: VEHICLE_ID, pairedDeviceId: null, lastSession: null })),
        });
        await expect(service.resolveContext('PT30_A86E', DRIVER_ID, VEHICLE_ID)).rejects.toMatchObject({
          status: 503, code: 'INGEST_ASSIGNMENT_PENDING', details: { pending: ['DEVICE_PAIRING'] },
        });
      });

      it('unpaired device claiming a unit that has another device -> 403 UNIT_HAS_OTHER_DEVICE', async () => {
        const { service } = makeService({
          findDeviceBySerial: jest.fn(async () => ({ ...device, vehicleId: null })),
          findAssociationState: jest.fn(async () => ({ holder: null, driverAssignedVehicleId: VEHICLE_ID, pairedDeviceId: 'dev_2', lastSession: null })),
        });
        await expect(service.resolveContext('PT30_A86E', DRIVER_ID, VEHICLE_ID)).rejects.toMatchObject({
          status: 403, details: { reason: 'UNIT_HAS_OTHER_DEVICE' },
        });
      });

      it('device paired with another unit stays 403 DEVICE_PAIRED_ELSEWHERE without a re-read', async () => {
        const { service, repo } = makeService({ findDeviceBySerial: jest.fn(async () => ({ ...device, vehicleId: 'other' })) });
        await expect(service.resolveContext('PT30_A86E', DRIVER_ID, VEHICLE_ID)).rejects.toMatchObject({
          status: 403, details: { reason: 'DEVICE_PAIRED_ELSEWHERE' },
        });
        expect(repo.findAssociationState).not.toHaveBeenCalled();
      });
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

  describe('B-165 — checksum absent vs mismatched; diagnostic 3 de-duplicated', () => {
    const codeRows = (rows: Array<Record<string, unknown>>) => rows.filter((r) => r.eventType === 7);

    it('no checksum → stored, NO diagnostic, one informational CHECKSUM_MISSING warning', async () => {
      const { service, captured } = makeService();
      const result = await service.ingestEvents(batch([baseEvent()]), DRIVER_ID);
      expect(result.accepted).toBe(1);
      expect(codeRows(captured.rows)).toHaveLength(0);
      expect(captured.rows[0].diagnosticCode).toBeNull();
      expect(captured.rows[0].checksum).toMatch(/^[0-9a-f]{16}$/);
      expect(result.diagnostics).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: 'CHECKSUM_MISSING', informational: true }),
      ]);
    });

    it('mismatch → exactly one 7/3 and CHECKSUM_MISMATCH', async () => {
      const { service, captured } = makeService();
      const result = await service.ingestEvents(batch([baseEvent({ checksum: 'deadbeefdeadbeef' })]), DRIVER_ID);
      const generated = codeRows(captured.rows);
      expect(generated).toHaveLength(1);
      expect(generated[0]).toMatchObject({ eventCode: 3, diagnosticCode: DIAGNOSTIC.MISSING_DATA, driverId: DRIVER_ID });
      expect(result.warnings.map((w) => w.code)).toEqual(['CHECKSUM_MISMATCH']);
      expect(result.warnings[0].informational).toBeUndefined();
    });

    it('5 bad events in one batch → ONE 7/3 for the driver, every event row still flagged', async () => {
      const { service, captured } = makeService();
      const t0 = Date.now() - 60 * 60 * 1000;
      const events = Array.from({ length: 5 }, (_, i) =>
        baseEvent({ uuid: `evt-bad-${i}`, checksum: 'deadbeefdeadbeef', eventDateTime: new Date(t0 + i * 60_000).toISOString() }),
      );
      const result = await service.ingestEvents(batch(events), DRIVER_ID);
      expect(codeRows(captured.rows)).toHaveLength(1);
      expect(captured.rows.filter((r) => r.eventType === 1 && r.diagnosticCode === '3')).toHaveLength(5);
      expect(result.warnings.filter((w) => w.code === 'CHECKSUM_MISMATCH')).toHaveLength(5);
      expect(result.accepted).toBe(6);
    });

    it('an already ACTIVE 7/3 for the driver → no new 7/3', async () => {
      const { service, captured, repo } = makeService({ findActiveCodes: jest.fn(async () => new Set(['D:3'])) });
      await service.ingestEvents(batch([baseEvent({ checksum: 'deadbeefdeadbeef' })]), DRIVER_ID);
      expect(codeRows(captured.rows)).toHaveLength(0);
      expect(repo.findActiveCodes).toHaveBeenCalledWith(
        expect.anything(),
        { driverId: DRIVER_ID, vehicleId: VEHICLE_ID },
        { diagnostic: ['3'] },
      );
    });

    it('an app-sent eventType 7 record keeps its own code (no diagnostic stamped on it)', async () => {
      const { service, captured } = makeService();
      await service.ingestEvents(
        batch([baseEvent({ eventType: 7, eventCode: 1, malfunctionCode: 'P', checksum: 'deadbeefdeadbeef', latitude: null, longitude: null })]),
        DRIVER_ID,
      );
      const own = captured.rows.find((r) => r.uuid === 'evt-0001');
      expect(own).toMatchObject({ malfunctionCode: 'P', diagnosticCode: null });
    });

    it('engine power 6/x without checksum gets no diagnostic', async () => {
      const { service, captured } = makeService();
      await service.ingestEvents(batch([baseEvent({ eventType: 6, eventCode: 3 })]), DRIVER_ID);
      expect(codeRows(captured.rows)).toHaveLength(0);
      expect(captured.rows[0]).toMatchObject({ diagnosticCode: null, malfunctionCode: null });
    });
  });

  describe('B-166 — no timing malfunction from late-delivered events', () => {
    it('a stored event delivered 709 s late → no T, timeDriftSec null, plain warnings', async () => {
      const { service, captured } = makeService();
      const at = new Date(Date.now() - 709 * 1000).toISOString();
      const result = await service.ingestEvents(
        batch([withChecksum({ eventDateTime: at, wasStoredOnDevice: true })]),
        DRIVER_ID,
      );
      expect(captured.rows.every((r) => r.malfunctionCode !== MALFUNCTION.TIMING)).toBe(true);
      expect(captured.rows[0].timeDriftSec).toBeNull();
      expect(result.malfunctions).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('a live event hours late / 20 min ahead → still no T', async () => {
      const { service, captured } = makeService();
      await service.ingestEvents(
        batch([
          withChecksum({ uuid: 'evt-late', eventDateTime: new Date(Date.now() - 5 * 3600_000).toISOString() }),
          withChecksum({ uuid: 'evt-ahead', eventDateTime: new Date(Date.now() + 20 * 60_000).toISOString() }),
        ]),
        DRIVER_ID,
      );
      expect(captured.rows.some((r) => r.malfunctionCode === MALFUNCTION.TIMING)).toBe(false);
    });
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

  it('§395 App. A 4.4.2 — a fix without locationName stores the offline geo-location of the coarsened fix', async () => {
    const { service, captured } = makeService();
    await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
    // baseEvent sits in downtown Columbus, OH
    expect(captured.rows[0].locationName).toMatch(/^(\d{1,2}mi [NSEW]{1,3} )?OH \S/);
  });

  it('an app-supplied locationName wins over the computed geo-location', async () => {
    const { service, captured } = makeService();
    await service.ingestEvents(batch([withChecksum({ locationName: 'Columbus yard gate 2' })]), DRIVER_ID);
    expect(captured.rows[0].locationName).toBe('Columbus yard gate 2');
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

  describe('B-181 / D-165 — recordStatus / recordOrigin are server-derived, client claims ignored', () => {
    it('a PT30 Driving record claimed inactive + driver-origin is stored ACTIVE, origin 1, batch not failed', async () => {
      const { service, captured } = makeService();
      const warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
      const result = await service.ingestEvents(
        batch([withChecksum({ uuid: 'evt-tamper-1', recordStatus: 2, recordOrigin: 2 })]),
        DRIVER_ID,
      );
      expect(result.accepted).toBeGreaterThanOrEqual(1);
      expect(captured.rows[0]).toMatchObject({ uuid: 'evt-tamper-1', driverId: DRIVER_ID, recordStatus: 1, recordOrigin: 1 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).toContain('evt-tamper-1');
      expect(String((warn.mock.calls[0] as unknown[])[1])).toContain('INGEST_RECORD_ATTRIBUTES_OVERRIDDEN');
    });

    it('every recordStatus 2..4 is ignored on any event type', async () => {
      const { service, captured } = makeService();
      await service.ingestEvents(
        batch([
          withChecksum({ uuid: 'evt-st-2', recordStatus: 2, eventCode: 4, recordOrigin: 2 }),
          withChecksum({ uuid: 'evt-st-3', recordStatus: 3, eventType: 6, eventCode: 1 }),
          withChecksum({ uuid: 'evt-st-4', recordStatus: 4, eventType: 2, eventCode: 1 }),
        ]),
        DRIVER_ID,
      );
      const stored = captured.rows.filter((r) => String(r.uuid).startsWith('evt-st-'));
      expect(stored.map((r) => r.recordStatus)).toEqual([1, 1, 1]);
    });

    it('automatic types (intermediate, engine power, malfunction) are forced to origin 1', async () => {
      const { service, captured } = makeService();
      await service.ingestEvents(
        batch([
          withChecksum({ uuid: 'evt-or-2', eventType: 2, eventCode: 1, recordOrigin: 2 }),
          withChecksum({ uuid: 'evt-or-6', eventType: 6, eventCode: 1, recordOrigin: 3 }),
          withChecksum({ uuid: 'evt-or-7', eventType: 7, eventCode: 3, recordOrigin: 2, diagnosticCode: '6' }),
        ]),
        DRIVER_ID,
      );
      const stored = captured.rows.filter((r) => String(r.uuid).startsWith('evt-or-'));
      expect(stored.map((r) => r.recordOrigin)).toEqual([1, 1, 1]);
    });

    it('a driver-selectable status keeps origin 1 or 2; origin 3/4 from a driver JWT becomes 2', async () => {
      const { service, captured } = makeService();
      await service.ingestEvents(
        batch([
          withChecksum({ uuid: 'evt-on-1', eventCode: 4, recordOrigin: 1 }),
          withChecksum({ uuid: 'evt-on-2', eventCode: 4, recordOrigin: 2 }),
          withChecksum({ uuid: 'evt-on-3', eventCode: 4, recordOrigin: 3 }),
          withChecksum({ uuid: 'evt-on-4', eventCode: 4, recordOrigin: 4 }),
        ]),
        DRIVER_ID,
      );
      const byUuid = new Map(captured.rows.map((r) => [r.uuid, r]));
      expect(byUuid.get('evt-on-1')).toMatchObject({ recordOrigin: 1, driverId: DRIVER_ID });
      expect(byUuid.get('evt-on-2')).toMatchObject({ recordOrigin: 2, driverId: DRIVER_ID });
      expect(byUuid.get('evt-on-3')).toMatchObject({ recordOrigin: 2, driverId: DRIVER_ID });
      expect(byUuid.get('evt-on-4')).toMatchObject({ recordOrigin: 2, driverId: DRIVER_ID });
    });

    it('a client origin 4 on live Driving is only a hint: an open session keeps it on the driver as origin 1', async () => {
      const { service, captured } = makeService({
        findSessionWindow: jest.fn(async () => ({ openSessionDriverId: DRIVER_ID, lastBefore: null, firstAfter: null })),
      });
      const warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
      const result = await service.ingestEvents(batch([withChecksum({ uuid: 'evt-hint-1', recordOrigin: 4 })]), DRIVER_ID);
      expect(captured.rows[0]).toMatchObject({ driverId: DRIVER_ID, recordOrigin: 1, recordStatus: 1 });
      expect(result.unidentifiedSegmentIds).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('a client origin 4 on live Driving with nobody logged in stays unidentified (origin 4 + segment)', async () => {
      const { service, captured } = makeService();
      const result = await service.ingestEvents(batch([withChecksum({ uuid: 'evt-hint-2', recordOrigin: 4 })]), DRIVER_ID);
      expect(captured.rows[0]).toMatchObject({ driverId: null, recordOrigin: 4 });
      expect(result.unidentifiedSegmentIds).toEqual(['seg_1']);
    });

    it('an honest batch (status 1, correct origins) logs no override trace', async () => {
      const { service } = makeService();
      const warn = jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => undefined);
      await service.ingestEvents(batch([withChecksum(), withChecksum({ uuid: 'evt-on-x', eventCode: 4, recordOrigin: 2 })]), DRIVER_ID);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('§7.3 rule 10 — a committed batch queues hos.recalc and pushes realtime', async () => {
    const { service, recalcJobs, published } = makeService();
    await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
    expect(recalcJobs[0].name).toBe('hos.recalc');
    expect(published).toContain('realtime.push');
  });

  describe('B-123 (certify option b) — a fresh duty record on a certified day voids the signature', () => {
    // 10:00 EDT on Jun 1 2026 = 14:00Z; the header is the New York RODS day 2026-06-01.
    // Signed at 12:00 EDT (16:00Z); records after that change what was certified.
    const header = {
      id: 'log-0601',
      driverId: DRIVER_ID,
      logDate: new Date('2026-06-01T00:00:00Z'),
      timezone: 'America/New_York',
      certifiedAt: new Date('2026-06-01T16:00:00Z'),
    };

    it('voids the certified day the record lands on and tells the app (log.changed)', async () => {
      const { service, repo, events } = makeService({ findCertifiedHeaders: jest.fn(async () => [header]) });
      await service.ingestEvents(
        batch([baseEvent({ uuid: 'evt-late-1', eventDateTime: '2026-06-01T18:00:00.000Z' })]),
        DRIVER_ID,
      );
      expect(repo.voidCertifications).toHaveBeenCalledWith(expect.anything(), ['log-0601']);
      expect(events.publish).toHaveBeenCalledWith('log.changed', { driverId: DRIVER_ID, dates: ['2026-06-01'] });
    });

    it('a record dated before the signature that only arrives now (offline queue) does not void it', async () => {
      const { service, repo } = makeService({ findCertifiedHeaders: jest.fn(async () => [header]) });
      await service.ingestEvents(
        batch([baseEvent({ uuid: 'evt-queued-1', eventDateTime: '2026-06-01T14:00:00.000Z' })]),
        DRIVER_ID,
      );
      expect(repo.voidCertifications).not.toHaveBeenCalled();
    });

    it('a record outside the certified day (in its zone) leaves the signature alone', async () => {
      const { service, repo } = makeService({ findCertifiedHeaders: jest.fn(async () => [header]) });
      // 02:00Z on Jun 2 is still 22:00 on Jun 1 in New York → voids; 05:00Z on Jun 2 is 01:00 Jun 2 → does not.
      await service.ingestEvents(
        batch([baseEvent({ uuid: 'evt-late-2', eventDateTime: '2026-06-02T05:00:00.000Z' })]),
        DRIVER_ID,
      );
      expect(repo.voidCertifications).not.toHaveBeenCalled();
    });

    it('login/logout and engine power records never void a signature', async () => {
      const { service, repo } = makeService({ findCertifiedHeaders: jest.fn(async () => [header]) });
      await service.ingestEvents(
        batch([
          baseEvent({ uuid: 'evt-logout', eventType: 5, eventCode: 2, eventDateTime: '2026-06-01T20:00:00.000Z' }),
          baseEvent({ uuid: 'evt-power', eventType: 6, eventCode: 3, eventDateTime: '2026-06-01T20:05:00.000Z' }),
        ]),
        DRIVER_ID,
      );
      expect(repo.voidCertifications).not.toHaveBeenCalled();
    });

    it('a re-sent (duplicate) record voids nothing', async () => {
      const { service, repo } = makeService({
        findExistingUuids: jest.fn(async () => new Set(['evt-dup-0001'])),
        findCertifiedHeaders: jest.fn(async () => [header]),
      });
      await service.ingestEvents(
        batch([baseEvent({ uuid: 'evt-dup-0001', eventDateTime: '2026-06-01T18:00:00.000Z' })]),
        DRIVER_ID,
      );
      expect(repo.voidCertifications).not.toHaveBeenCalled();
    });
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

describe('IngestService — Virtual ELD gate (pt30_pt40/tz.md §9.3)', () => {
  const virtualDevice = { ...device, serial: 'VPT30_A1B2', isVirtual: true };
  const realPolicy = (enabled: boolean) =>
    new VirtualEldPolicy({ virtualEldAllowed: true } as never, { get: jest.fn(async () => ({ virtualEldEnabled: enabled })) } as never);
  const calls = (service: IngestService) => ({
    events: () => service.ingestEvents(IngestEventsDto.parse({ deviceSerial: 'VPT30_A1B2', vehicleId: VEHICLE_ID, batch: [withChecksum()] }), DRIVER_ID),
    telemetry: () =>
      service.ingestTelemetry(IngestTelemetryDto.parse({ deviceSerial: 'VPT30_A1B2', vehicleId: VEHICLE_ID, points: [{ time: '2026-10-10T12:00:00Z' }] }), DRIVER_ID),
    bleState: () => service.recordBleState(IngestBleStateDto.parse({ deviceSerial: 'VPT30_A1B2', state: 'CONNECTED', at: '2026-10-10T12:00:00Z' }), DRIVER_ID),
    deviceStatus: () => service.recordDeviceStatus(IngestDeviceStatusDto.parse({ deviceSerial: 'VPT30_A1B2', storedEventsCount: 0 }), DRIVER_ID),
    deviceConfig: () => service.resolveOwnedDevice('VPT30_A1B2', DRIVER_ID),
  });

  it.each(['events', 'telemetry', 'bleState', 'deviceStatus', 'deviceConfig'] as const)(
    '%s from a virtual device -> 403 VIRTUAL_ELD_DISABLED while the switch is off, nothing written',
    async (name) => {
      const { service, repo } = makeService({ findDeviceBySerial: jest.fn(async () => virtualDevice), virtualEld: realPolicy(false) });
      await expect(calls(service)[name]()).rejects.toMatchObject({ code: 'VIRTUAL_ELD_DISABLED', status: 403 });
      expect(repo.insertEvents).not.toHaveBeenCalled();
      expect(repo.updateDeviceOutsideTx).not.toHaveBeenCalled();
    },
  );

  it('a virtual device ingests normally while the switch is on', async () => {
    const { service, captured } = makeService({ findDeviceBySerial: jest.fn(async () => virtualDevice), virtualEld: realPolicy(true) });
    const result = await service.ingestEvents(IngestEventsDto.parse({ deviceSerial: 'VPT30_A1B2', vehicleId: VEHICLE_ID, batch: [withChecksum()] }), DRIVER_ID);
    expect(result.accepted).toBe(1);
    expect(captured.rows).toHaveLength(1);
  });

  it('a real device is unaffected even with the switch off', async () => {
    const { service, captured } = makeService({ virtualEld: realPolicy(false) });
    await service.ingestEvents(batch([withChecksum()]), DRIVER_ID);
    expect(captured.rows).toHaveLength(1);
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

  it('MG-BLE-7 — no alert.eld_disconnected before the first ever connection', async () => {
    const { service, alerts } = makeService({
      findDeviceBySerial: jest.fn(async () => ({ ...device, lastSeenAt: null })),
    });
    const result = await service.recordBleState({ deviceSerial: 'PT30_A86E', state: 'DISCONNECTED' }, DRIVER_ID);
    expect(result.disconnectedAlert).toBe(false);
    expect(alerts).not.toContain('alert.eld_disconnected');
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

describe('IngestService — B-166 device clock drift from deviceTime (§7.8 T, App. A 4.6.1.3)', () => {
  const status = (deviceTime?: string) =>
    IngestDeviceStatusDto.parse({ deviceSerial: 'PT30_A86E', storedEventsCount: 0, ...(deviceTime && { deviceTime }) });
  const timingRows = (rows: Array<Record<string, unknown>>) =>
    rows.filter((r) => r.eventType === 7 && r.malfunctionCode === MALFUNCTION.TIMING);

  it('deviceTime 15 min off → ONE 7/1 T + alert; a repeat while T is active logs nothing', async () => {
    let active = new Set<string>();
    const h = makeService({ findActiveCodes: jest.fn(async () => active) });
    const off = () => new Date(Date.now() - 15 * 60_000).toISOString();

    const first = await h.service.recordDeviceStatus(status(off()), DRIVER_ID);
    expect(first.clockDriftSec).toBeLessThan(-600);
    expect(first.codes).toContain('M:T');
    expect(timingRows(h.captured.rows)).toEqual([
      expect.objectContaining({ eventCode: 1, driverId: DRIVER_ID, vehicleId: VEHICLE_ID }),
    ]);
    expect(h.alerts).toContain('alert.eld_malfunction');

    active = new Set(['M:T']);
    await h.service.recordDeviceStatus(status(off()), DRIVER_ID);
    expect(timingRows(h.captured.rows)).toHaveLength(1);
  });

  it('back within 10 min while T is active → one 7/2 clear record', async () => {
    const h = makeService({ findActiveCodes: jest.fn(async () => new Set(['M:T'])) });
    const result = await h.service.recordDeviceStatus(status(new Date().toISOString()), DRIVER_ID);
    expect(result.codes).not.toContain('M:T');
    expect(timingRows(h.captured.rows)).toEqual([expect.objectContaining({ eventCode: 2 })]);
  });

  it('no deviceTime → no timing check at all', async () => {
    const h = makeService();
    const result = await h.service.recordDeviceStatus(status(), DRIVER_ID);
    expect(result.clockDriftSec).toBeNull();
    expect(h.repo.findActiveCodes).not.toHaveBeenCalled();
    expect(timingRows(h.captured.rows)).toHaveLength(0);
  });

  it('ble-state deviceTime 15 min ahead → T once', async () => {
    const h = makeService();
    const result = await h.service.recordBleState(
      IngestBleStateDto.parse({ deviceSerial: 'PT30_A86E', state: 'CONNECTED', deviceTime: new Date(Date.now() + 15 * 60_000).toISOString() }),
      DRIVER_ID,
    );
    expect(result.clockDriftSec).toBeGreaterThan(600);
    expect(timingRows(h.captured.rows)).toHaveLength(1);
  });
});

describe('IngestService — PT SDK 6.11 (D-135)', () => {
  const sdkDevice = {
    ...device,
    model: 'PT30',
    reportedVin: null,
    periodicConnectedSec: 30,
    periodicNoBleSec: 60,
    harshAccelMg: 0,
    harshBrakeMg: 450,
    harshCornerMg: 0,
    autoFirmware: true,
    shareDiagnostics: true,
    connectionType: null,
  } as unknown as Device;
  const vinVehicle: Vehicle = { ...vehicle, vin: '1FUJGLDR7CLBP8834' };

  function sdkService() {
    return makeService({
      findDeviceBySerial: jest.fn(async () => sdkDevice),
      findVehicle: jest.fn(async () => vinVehicle),
      updateDeviceOutsideTx: jest.fn(async (_id: string, data: Record<string, unknown>) => ({ ...sdkDevice, ...data })),
    });
  }

  it('device-status: PT40-C normalises the model, stores TrackerInfo and answers systemVars', async () => {
    const { service, repo } = sdkService();
    const result = await service.recordDeviceStatus(
      {
        deviceSerial: 'PT30_A86E',
        storedEventsCount: 0,
        recordsLost: false,
        consecutiveTransferFailures: 0,
        productName: 'PT40-C',
        mainFirmware: 'L110',
        bleFirmware: '1.4.2',
        imei: '356938035643809',
        connectionType: 'USB',
        busType: 'J1939',
        appPlatform: 'ANDROID',
        sdkVersion: '6.11.1',
      },
      DRIVER_ID,
    );
    expect(repo.updateDeviceOutsideTx).toHaveBeenCalledWith(
      'dev_1',
      expect.objectContaining({
        model: 'PT40', productName: 'PT40-C', firmware: 'L110', bleFirmware: '1.4.2', imei: '356938035643809',
        connectionType: 'USB', busType: 'J1939', appPlatform: 'ANDROID', sdkVersion: '6.11.1',
      }),
    );
    const written = repo.updateDeviceOutsideTx.mock.calls[0] as [string, { lastInfoAt?: unknown }];
    expect(written[1].lastInfoAt).toBeInstanceOf(Date);
    expect(result.model).toBe('PT40');
    expect(result.vinMismatch).toBe(false);
    expect(result.systemVars).toEqual({
      PERIODIC_EVENT_GAP: 30, PERIODIC_EVENT_GAP_NOBLE: 60, EVENTS_STORED: 1,
      DRIVING_ACCL: 0, DRIVING_BRAKING: 450, DRIVING_CORNERING: 0, HSI_MODE: 1,
    });
    expect(result.configVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it('device-status: a different reported VIN flags vinMismatch and alerts once, never blocks', async () => {
    const { service, alerts } = sdkService();
    const result = await service.recordDeviceStatus(
      { deviceSerial: 'PT30_A86E', storedEventsCount: 0, recordsLost: false, consecutiveTransferFailures: 0, reportedVin: '1FUJGLDR7CLBP9999' },
      DRIVER_ID,
    );
    expect(result.vinMismatch).toBe(true);
    expect(alerts).toContain('alert.device_vin_mismatch');
  });

  it('device-status: the same mismatching VIN already on record does not re-alert', async () => {
    const { service, alerts } = makeService({
      findDeviceBySerial: jest.fn(async () => ({ ...sdkDevice, reportedVin: '1FUJGLDR7CLBP9999' })),
      findVehicle: jest.fn(async () => vinVehicle),
    });
    const result = await service.recordDeviceStatus(
      { deviceSerial: 'PT30_A86E', storedEventsCount: 0, recordsLost: false, consecutiveTransferFailures: 0, reportedVin: '1FUJGLDR7CLBP9999' },
      DRIVER_ID,
    );
    expect(result.vinMismatch).toBe(true);
    expect(alerts).not.toContain('alert.device_vin_mismatch');
  });

  it('ble-state stores connectionType', async () => {
    const { service, repo } = sdkService();
    const result = await service.recordBleState({ deviceSerial: 'PT30_A86E', state: 'CONNECTED', connectionType: 'USB' }, DRIVER_ID);
    expect(result.connectionType).toBe('USB');
    expect(repo.updateDeviceOutsideTx).toHaveBeenCalledWith('dev_1', expect.objectContaining({ connectionType: 'USB' }));
  });

  it('telemetry: fix-less points reach safety.detect with null coordinates; the point VIN lands on the device', async () => {
    const { service, repo } = sdkService();
    const queue = (service as unknown as { safetyDetectQueue: { add: jest.Mock<Promise<void>, [string, unknown]> } }).safetyDetectQueue;
    await service.ingestTelemetry(
      {
        deviceSerial: 'PT30_A86E',
        vehicleId: VEHICLE_ID,
        points: [{ time: new Date('2026-10-10T12:00:00Z'), isTransition: false, rpm: 900, vin: '1fujgldr7clbp8834' }],
      },
      DRIVER_ID,
    );
    const job = queue.add.mock.calls[0][1] as { points: Array<{ latitude: unknown }>; deviceHarsh: unknown };
    expect(job.points[0].latitude).toBeNull();
    expect(job.deviceHarsh).toEqual({ accel: false, brake: true, corner: false });
    expect(repo.updateDeviceOutsideTx).toHaveBeenCalledWith('dev_1', expect.objectContaining({ reportedVin: '1FUJGLDR7CLBP8834' }));
  });

  it('telemetry.point carries the latest fix (uncoarsened) to the vehicle and fleet rooms (D-149)', async () => {
    const { service, events } = sdkService();
    await service.ingestTelemetry(
      {
        deviceSerial: 'PT30_A86E',
        vehicleId: VEHICLE_ID,
        points: [
          { time: new Date('2026-10-10T12:00:00Z'), isTransition: false, latitude: 39.9, longitude: -83.0, speedKmh: 80 },
          { time: new Date('2026-10-10T12:01:00Z'), isTransition: false, latitude: 39.961176, longitude: -82.998794, speedKmh: 96.6, headingDeg: 90 },
        ],
      },
      DRIVER_ID,
    );
    const push = events.publish.mock.calls.find(([name]: [string, unknown?]) => name === 'realtime.push')?.[1] as {
      room: string[];
      event: string;
      payload: Record<string, unknown>;
    };
    expect(push.event).toBe('telemetry.point');
    expect(push.room).toEqual([`vehicle:${VEHICLE_ID}`, 'fleet']);
    expect(push.payload).toMatchObject({ vehicleId: VEHICLE_ID, latitude: 39.961176, longitude: -82.998794, speedMph: 60, headingDeg: 90 });
  });
});
