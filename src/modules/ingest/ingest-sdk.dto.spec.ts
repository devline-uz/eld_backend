/** PT SDK 6.11 alignment — ingest DTO normalisation (D-135). */
import {
  IngestDeviceEventsDto,
  IngestDeviceStatusDto,
  IngestTelemetryDto,
  normaliseBusType,
  normaliseDeviceEventType,
} from './dto/ingest.dto';

const VEHICLE_ID = '11111111-1111-4111-8111-111111111111';

function telemetry(point: Record<string, unknown>) {
  return IngestTelemetryDto.safeParse({
    deviceSerial: 'PT30_A86E',
    vehicleId: VEHICLE_ID,
    points: [{ time: '2026-10-10T12:00:00Z', ...point }],
  });
}

describe('normaliseBusType', () => {
  it.each([
    ['J1939', 'J1939'],
    ['j1708', 'J1708'],
    ['OBD_II', 'OBD_II'],
    ['OBDII', 'OBD_II'],
    ['OBD2', 'OBD_II'],
    ['OBD-II', 'OBD_II'],
    [1, 'OBD_II'],
    [2, 'J1708'],
    [4, 'J1939'],
    ['CAN', null],
    [3, null],
  ])('%p -> %p', (input, expected) => {
    expect(normaliseBusType(input)).toBe(expected);
  });
});

describe('TelemetryPointDto (SDK 6.11)', () => {
  it('accepts a point without coordinates', () => {
    expect(telemetry({ rpm: 900 }).success).toBe(true);
    expect(telemetry({ latitude: null, longitude: null }).success).toBe(true);
  });

  it('accepts engine load up to 250 % and rejects above', () => {
    expect(telemetry({ loadPct: 250 }).success).toBe(true);
    expect(telemetry({ loadPct: 251 }).success).toBe(false);
  });

  it('stores an integer gear as text', () => {
    const parsed = telemetry({ gear: 10 });
    expect(parsed.success && parsed.data.points[0].gear).toBe('10');
  });

  it('normalises SDK bus spellings and drops unknown labels instead of failing the batch', () => {
    const a = telemetry({ busType: 'OBD-II' });
    const b = telemetry({ busType: 4 });
    const c = telemetry({ busType: 'CANBUS' });
    expect(a.success && a.data.points[0].busType).toBe('OBD_II');
    expect(b.success && b.data.points[0].busType).toBe('J1939');
    expect(c.success && c.data.points[0].busType).toBeNull();
  });

  it('accepts up to 50 bus-specific DTC items and rejects 51', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ code: `P03${String(i).padStart(2, '0')}`, bus: 'OBDII' }));
    expect(telemetry({ dtcCodes: items }).success).toBe(true);
    expect(telemetry({ dtcCodes: [...items, { code: 'P0400' }] }).success).toBe(false);
    const parsed = telemetry({ dtcCodes: [{ spn: 254, isSid: true, fmi: 3, bus: 2, occurrence: 4, active: true }] });
    expect(parsed.success && parsed.data.points[0].dtcCodes?.[0]).toMatchObject({ bus: 'J1708', isSid: true, occurrence: 4 });
  });
});

describe('normaliseDeviceEventType', () => {
  it.each([
    ['EV_MEMS_BRK', 'HARSH_BRAKE'],
    ['ev_mems_acc', 'HARSH_ACCEL'],
    ['EV_MEMS_COR', 'HARSH_CORNER'],
    ['EV_ENGINE_ON', 'ENGINE_ON'],
    ['HARSH_BRAKE', 'HARSH_BRAKE'],
    ['PERIODIC', 'PERIODIC'],
    ['MEMS_BRK', 'HARSH_BRAKE'],
    ['EV_SOMETHING_NEW', 'UNKNOWN'],
    ['constructor', 'UNKNOWN'],
  ])('%p -> %p', (input, expected) => {
    expect(normaliseDeviceEventType(input)).toBe(expected);
  });
});

describe('IngestDeviceEventsDto', () => {
  const base = { type: 'EV_PERIODIC', seq: 1, occurredAt: '2026-10-10T12:00:00Z', live: true };

  it('accepts SDK string odometer / engine hours', () => {
    const parsed = IngestDeviceEventsDto.parse({
      deviceSerial: 'PT30_A86E',
      vehicleId: VEHICLE_ID,
      events: [{ ...base, odometerKm: '182345.6', engineHours: '5123.4' }],
    });
    expect(parsed.events[0]).toMatchObject({ type: 'PERIODIC', odometerKm: 182345.6, engineHours: 5123.4 });
  });

  it('caps the batch at 500 events', () => {
    const events = Array.from({ length: 501 }, (_, i) => ({ ...base, seq: i }));
    expect(IngestDeviceEventsDto.safeParse({ deviceSerial: 'S', vehicleId: VEHICLE_ID, events }).success).toBe(false);
  });

  it('rejects a schema violation (missing seq)', () => {
    const { seq: _seq, ...noSeq } = base;
    expect(IngestDeviceEventsDto.safeParse({ deviceSerial: 'S', vehicleId: VEHICLE_ID, events: [noSeq] }).success).toBe(false);
  });
});

describe('IngestDeviceStatusDto (SDK TrackerInfo)', () => {
  it('accepts the TrackerInfo fields and upper-cases the VIN', () => {
    const parsed = IngestDeviceStatusDto.parse({
      deviceSerial: 'PT30_A86E',
      storedEventsCount: 0,
      productName: 'PT40-C',
      mainFirmware: 'L110',
      bleFirmware: '1.4.2',
      imei: '356938035643809',
      reportedVin: ' 1fujgldr7clbp8834 ',
      connectionType: 'USB',
      busType: 'OBD2',
      appPlatform: 'ANDROID',
    });
    expect(parsed).toMatchObject({ reportedVin: '1FUJGLDR7CLBP8834', busType: 'OBD_II', connectionType: 'USB' });
  });

  it('rejects an unknown connectionType', () => {
    expect(IngestDeviceStatusDto.safeParse({ deviceSerial: 'S', storedEventsCount: 0, connectionType: 'WIFI' }).success).toBe(false);
  });
});
