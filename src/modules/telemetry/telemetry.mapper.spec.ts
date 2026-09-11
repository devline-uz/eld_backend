import { distanceMi } from '../../common/units';
import type { TelemetryPointDto } from '../ingest/dto/ingest.dto';
import { inspectDownsampling, toTelemetryRow } from './telemetry.mapper';

const point = (over: Partial<TelemetryPointDto> = {}): TelemetryPointDto => ({
  time: new Date('2025-09-10T06:30:00Z'),
  latitude: 39.961176,
  longitude: -82.998794,
  isTransition: false,
  ...over,
});

const ctx = { vehicleId: 'veh_1', driverId: 'drv_1', odometerOffsetMi: 18_044, pcActive: false };

describe('telemetry/mapper — §4.2 conversion + §7.3 rule 9 coarsening', () => {
  it('stores imperial, never metric', () => {
    const row = toTelemetryRow(
      point({
        speedKmh: 105,
        odometerKm: 8140,
        fuelRateLph: 10,
        fuelEconomyKmpl: 3,
        totalFuelUsedL: 378.541,
        oilPressureKpa: 689.476,
      }),
      ctx,
    );
    expect(row.speedMph).toBe(65);
    expect(row.odometerMi).toBe(5058 + 18_044); // kmToMi(8140) + offset (§4.3)
    expect(row.fuelRateGph).toBe(2.64);
    expect(row.fuelEconomyMpg).toBe(7.1);
    expect(row.totalFuelUsedGal).toBe(100);
    expect(row.oilPressurePsi).toBe(100);
  });

  it('leaves Celsius alone and passes absent parameters through as null (§5.6 note)', () => {
    const row = toTelemetryRow(point({ coolantTempC: 88 }), ctx);
    expect(row.coolantTempC).toBe(88);
    expect(row.rpm).toBeNull();
    expect(row.fuelPct).toBeNull();
    expect(row.busType).toBeNull();
  });

  it('coarsens the position to 1 mile before storage — the raw coordinate is never kept', () => {
    const row = toTelemetryRow(point(), ctx);
    expect(row.latitude).not.toBe(39.961176);
    expect(distanceMi({ lat: row.latitude, lon: row.longitude }, { lat: 39.961176, lon: -82.998794 })).toBeLessThanOrEqual(1);
  });

  it('coarsens to 10 miles while Personal Conveyance is active', () => {
    const row = toTelemetryRow(point(), { ...ctx, pcActive: true });
    const off = distanceMi(
      { lat: row.latitude, lon: row.longitude },
      { lat: 39.961176, lon: -82.998794 },
    );
    expect(off).toBeLessThanOrEqual(10);
    expect(row.latitude).not.toBe(39.961176);
  });
});

describe('telemetry/downsampling — §7.5', () => {
  it('counts points denser than 1/60 s but never drops them', () => {
    const points = [
      point({ time: new Date('2025-09-10T06:30:00Z') }),
      point({ time: new Date('2025-09-10T06:30:30Z') }),
      point({ time: new Date('2025-09-10T06:31:00Z') }),
    ];
    const report = inspectDownsampling(points);
    expect(report.dense).toBe(1);
    expect(report.kept).toHaveLength(3);
  });

  it('never counts a transition point as dense — transitions are never dropped', () => {
    const points = [
      point({ time: new Date('2025-09-10T06:30:00Z') }),
      point({ time: new Date('2025-09-10T06:30:05Z'), isTransition: true }),
      point({ time: new Date('2025-09-10T06:30:10Z'), isTransition: true }),
    ];
    expect(inspectDownsampling(points).dense).toBe(0);
  });

  it('orders points by time', () => {
    const report = inspectDownsampling([
      point({ time: new Date('2025-09-10T06:32:00Z') }),
      point({ time: new Date('2025-09-10T06:30:00Z') }),
    ]);
    expect(report.kept[0].time.toISOString()).toBe('2025-09-10T06:30:00.000Z');
  });
});
