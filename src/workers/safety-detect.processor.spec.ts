import { SafetyDetectProcessor } from './safety-detect.processor';

function buildProcessor(fences: unknown[] = []) {
  const createManyCalls: unknown[] = [];
  const alertJobs: Array<{ name: string; data: unknown }> = [];
  const publishedEvents: string[] = [];

  const prisma = { telemetryPoint: { findFirst: jest.fn(async () => null) } };
  const safety = { createMany: jest.fn(async (rows: unknown[]) => createManyCalls.push(...rows)) };
  const geofences = { activeCircleFences: jest.fn(async () => fences) };
  const events = { publish: jest.fn(async (name: string) => publishedEvents.push(name)) };
  const alertQueue = { add: jest.fn(async (name: string, data: unknown) => alertJobs.push({ name, data })) };

  const processor = new SafetyDetectProcessor(
    prisma as never,
    safety as never,
    geofences as never,
    events as never,
    alertQueue as never,
  );
  return { processor, prisma, safety, geofences, events, alertQueue, createManyCalls, alertJobs, publishedEvents };
}

describe('SafetyDetectProcessor — harsh events', () => {
  it('persists a SafetyEvent and enqueues an alert when a harsh event is detected', async () => {
    const { processor, createManyCalls, alertJobs } = buildProcessor();
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [
          { time: '2026-09-11T00:00:00.000Z', latitude: 40, longitude: -83, speedKmh: 80 },
          { time: '2026-09-11T00:00:01.000Z', latitude: 40, longitude: -83, speedKmh: 40 },
        ],
      },
    } as never);
    expect(createManyCalls).toHaveLength(1);
    expect((createManyCalls[0] as { type: string }).type).toBe('HARSH_BRAKING');
    expect(alertJobs).toHaveLength(1);
    expect(alertJobs[0].name).toBe('alert.harsh_event');
  });

  it('does nothing for a smooth speed profile', async () => {
    const { processor, createManyCalls } = buildProcessor();
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [
          { time: '2026-09-11T00:00:00.000Z', latitude: 40, longitude: -83, speedKmh: 60 },
          { time: '2026-09-11T00:00:01.000Z', latitude: 40, longitude: -83, speedKmh: 61 },
        ],
      },
    } as never);
    expect(createManyCalls).toHaveLength(0);
  });

  it('is a no-op for an empty point batch', async () => {
    const { processor, safety, geofences } = buildProcessor();
    await processor.process({ data: { vehicleId: 'veh_1', driverId: null, points: [] } } as never);
    expect(safety.createMany).not.toHaveBeenCalled();
    expect(geofences.activeCircleFences).not.toHaveBeenCalled();
  });
});

describe('SafetyDetectProcessor — geofences', () => {
  const fence = {
    id: 'gf_1',
    centerLat: 40.0,
    centerLon: -83.0,
    radiusMi: 1,
    alertOnEnter: true,
    alertOnExit: true,
  };

  it('raises alert.geofence_enter when the vehicle crosses into a fence with no prior point', async () => {
    const { processor, alertJobs } = buildProcessor([fence]);
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [
          { time: '2026-09-11T00:00:00.000Z', latitude: 41.0, longitude: -83.0 },
          { time: '2026-09-11T00:00:01.000Z', latitude: 40.0, longitude: -83.0 },
        ],
      },
    } as never);
    expect(alertJobs.some((j) => j.name === 'alert.geofence_enter')).toBe(true);
  });

  it('raises no geofence alert when there are no active fences', async () => {
    const { processor, alertJobs } = buildProcessor([]);
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [{ time: '2026-09-11T00:00:00.000Z', latitude: 40.0, longitude: -83.0 }],
      },
    } as never);
    expect(alertJobs.filter((j) => j.name.startsWith('alert.geofence'))).toHaveLength(0);
  });
});
