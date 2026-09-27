import { buildVehicleHistories, HistoryPoint } from './vehicle-histories';

function point(overrides: Partial<HistoryPoint>): HistoryPoint {
  return {
    time: new Date('2026-09-24T12:00:00.000Z'),
    speedMph: 0,
    engineOn: false,
    odometerMi: 1000,
    totalFuelIdleGal: null,
    driverId: null,
    lat: 40,
    lon: -83,
    ...overrides,
  };
}

describe('buildVehicleHistories', () => {
  it('returns zeroed KPIs and no segments for an empty day', () => {
    const result = buildVehicleHistories('2026-09-24', [], new Map());
    expect(result).toEqual(
      expect.objectContaining({ date: '2026-09-24', distanceMi: 0, driveSegments: 0, segments: [], firstMovementAt: null, lastMovementAt: null }),
    );
  });

  it('segments a DRIVE run bounded by STOPs and sums distance/time correctly', () => {
    const points: HistoryPoint[] = [
      point({ time: new Date('2026-09-24T11:00:00.000Z'), speedMph: 0, engineOn: false, odometerMi: 1000 }),
      point({ time: new Date('2026-09-24T12:00:00.000Z'), speedMph: 55, engineOn: true, odometerMi: 1000, driverId: 'drv_1' }),
      point({ time: new Date('2026-09-24T12:30:00.000Z'), speedMph: 60, engineOn: true, odometerMi: 1030, driverId: 'drv_1' }),
      point({ time: new Date('2026-09-24T13:00:00.000Z'), speedMph: 0, engineOn: false, odometerMi: 1060 }),
    ];
    const driverNameById = new Map([['drv_1', 'John Smith']]);

    const result = buildVehicleHistories('2026-09-24', points, driverNameById);

    expect(result.segments.map((s) => s.type)).toEqual(['STOP', 'DRIVE', 'STOP']);
    expect(result.driveSegments).toBe(1);
    // A segment's `endAt` is the next segment's first point (full coverage, no gaps):
    // DRIVE runs 12:00 (first DRIVE point) -> 13:00 (first point of the next, STOP, segment).
    expect(result.driveTimeSec).toBe(3600);
    // distance is measured within the DRIVE group's own points only: 1030 - 1000.
    expect(result.distanceMi).toBe(30);
    expect(result.segments[1].driverName).toBe('John Smith');
    expect(result.firstMovementAt).toBe('2026-09-24T12:00:00.000Z');
    expect(result.lastMovementAt).toBe('2026-09-24T13:00:00.000Z');
  });

  it('classifies not-moving + engine on as IDLE, not-moving + engine off as STOP', () => {
    const points: HistoryPoint[] = [
      point({ time: new Date('2026-09-24T09:00:00.000Z'), speedMph: 0, engineOn: true }),
      point({ time: new Date('2026-09-24T09:10:00.000Z'), speedMph: 0, engineOn: false }),
    ];
    const result = buildVehicleHistories('2026-09-24', points, new Map());
    expect(result.segments[0].type).toBe('IDLE');
    expect(result.idleTimeSec).toBe(600);
    expect(result.stopTimeSec).toBe(0); // last segment has no "next" boundary, duration 0
  });

  it('finds the max speed point across the whole day', () => {
    const points: HistoryPoint[] = [
      point({ time: new Date('2026-09-24T09:00:00.000Z'), speedMph: 40, engineOn: true }),
      point({ time: new Date('2026-09-24T09:05:00.000Z'), speedMph: 72, engineOn: true }),
      point({ time: new Date('2026-09-24T09:10:00.000Z'), speedMph: 55, engineOn: true }),
    ];
    const result = buildVehicleHistories('2026-09-24', points, new Map());
    expect(result.maxSpeedMph).toBe(72);
    expect(result.maxSpeedAt).toBe('2026-09-24T09:05:00.000Z');
  });
});
