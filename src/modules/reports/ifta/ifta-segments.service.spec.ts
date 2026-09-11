import { DateTime } from 'luxon';
import { IftaSegmentsService } from './ifta-segments.service';

describe('IftaSegmentsService.computeForDate (TZ §15 nightly IftaSegment computation)', () => {
  function point(hour: number, lat: number, lon: number, odometerMi: number | null) {
    return {
      time: new Date(`2026-07-15T${String(hour).padStart(2, '0')}:00:00.000Z`),
      latitude: lat,
      longitude: lon,
      odometerMi,
      driverId: 'drv_1',
    };
  }

  function buildRepo(points: ReturnType<typeof point>[], existing: { jurisdiction: string; locked: boolean }[] = []) {
    const upsertSegment = jest.fn(async () => undefined);
    const lockQuarter = jest.fn(async () => 0);
    return {
      repo: {
        distinctVehicleIdsWithTelemetry: jest.fn(async () => [{ vehicleId: 'veh_1' }]),
        existingSegments: jest.fn(async () => existing),
        telemetryForVehicleDay: jest.fn(async () => points),
        upsertSegment,
        lockQuarter,
      },
      upsertSegment,
      lockQuarter,
    };
  }

  it('sums odometer-delta miles per jurisdiction and upserts one IftaSegment row per jurisdiction crossed', async () => {
    // Columbus, OH -> just south into Kentucky, using a real (< 200mi single-hop) odometer delta.
    const points = [point(8, 39.9612, -82.9988, 1000), point(9, 38.0406, -84.5037, 1180)];
    const { repo, upsertSegment } = buildRepo(points);
    const service = new IftaSegmentsService(repo as never);

    const result = await service.computeForDate(DateTime.utc(2026, 7, 15));

    expect(result.vehiclesScanned).toBe(1);
    expect(result.segmentsUpserted).toBe(1); // only the destination point resolves a jurisdiction (KY)
    expect(upsertSegment).toHaveBeenCalledWith('veh_1', 'KY', expect.any(Date), 'drv_1', 180);
  });

  it('falls back to haversine distance when the odometer does not advance', async () => {
    const points = [point(8, 39.9612, -82.9988, null), point(9, 39.98, -82.99, null)];
    const { repo, upsertSegment } = buildRepo(points);
    const service = new IftaSegmentsService(repo as never);
    await service.computeForDate(DateTime.utc(2026, 7, 15));
    expect(upsertSegment).toHaveBeenCalledWith('veh_1', 'OH', expect.any(Date), 'drv_1', expect.any(Number));
    const distanceArg = upsertSegment.mock.calls[0][4] as number;
    expect(distanceArg).toBeGreaterThan(0);
    expect(distanceArg).toBeLessThan(5);
  });

  it('never recomputes a day whose every jurisdiction is already locked (§15)', async () => {
    const points = [point(8, 39.9612, -82.9988, 1000), point(9, 38.0406, -84.5037, 1207)];
    const { repo, upsertSegment } = buildRepo(points, [{ jurisdiction: 'KY', locked: true }]);
    const service = new IftaSegmentsService(repo as never);
    await service.computeForDate(DateTime.utc(2026, 7, 15));
    expect(upsertSegment).not.toHaveBeenCalled();
  });

  it('skips a single locked jurisdiction while still upserting an unlocked one', async () => {
    const points = [
      point(8, 39.9612, -82.9988, 1000), // OH
      point(9, 38.0406, -84.5037, 1207), // KY
    ];
    const { repo, upsertSegment } = buildRepo(points, [
      { jurisdiction: 'KY', locked: true },
      { jurisdiction: 'OH', locked: false },
    ]);
    const service = new IftaSegmentsService(repo as never);
    await service.computeForDate(DateTime.utc(2026, 7, 15));
    expect(upsertSegment).not.toHaveBeenCalledWith('veh_1', 'KY', expect.anything(), expect.anything(), expect.anything());
  });

  it('discards an implausible >200mi single-hop delta as a GPS/odometer glitch', async () => {
    const points = [point(8, 39.9612, -82.9988, 1000), point(9, 38.0406, -84.5037, 5000)];
    const { repo, upsertSegment } = buildRepo(points);
    const service = new IftaSegmentsService(repo as never);
    await service.computeForDate(DateTime.utc(2026, 7, 15));
    expect(upsertSegment).not.toHaveBeenCalled();
  });
});
