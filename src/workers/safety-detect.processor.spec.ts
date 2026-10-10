import { SafetyDetectProcessor } from './safety-detect.processor';

function buildProcessor(fences: unknown[] = [], vehicleGroupId: string | null = null) {
  const createManyCalls: unknown[] = [];
  const alertJobs: Array<{ name: string; data: unknown }> = [];
  const publishedEvents: string[] = [];

  const prisma = {
    telemetryPoint: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async (): Promise<Array<{ time: Date; latitude: number; longitude: number }>> => []),
    },
    carrier: { findFirst: jest.fn(async () => ({ timezone: 'America/New_York' })) },
    vehicle: { findUnique: jest.fn(async () => ({ groupId: vehicleGroupId })) },
  };
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

  it('§20 B-15 — suppresses an after-hours-only ENTER during business hours (UTC carrier tz)', async () => {
    const afterHoursFence = { ...fence, afterHoursOnly: true };
    const { processor, alertJobs, prisma } = buildProcessor([afterHoursFence]);
    prisma.carrier.findFirst = jest.fn(async () => ({ timezone: 'UTC' }));
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [
          { time: '2026-09-11T14:00:00.000Z', latitude: 41.0, longitude: -83.0 },
          { time: '2026-09-11T14:00:01.000Z', latitude: 40.0, longitude: -83.0 },
        ],
      },
    } as never);
    expect(alertJobs.some((j) => j.name === 'alert.geofence_enter')).toBe(false);
  });

  it('§20 B-15 — allows an after-hours-only ENTER at 22:00 UTC', async () => {
    const afterHoursFence = { ...fence, afterHoursOnly: true };
    const { processor, alertJobs, prisma } = buildProcessor([afterHoursFence]);
    prisma.carrier.findFirst = jest.fn(async () => ({ timezone: 'UTC' }));
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [
          { time: '2026-09-11T22:00:00.000Z', latitude: 41.0, longitude: -83.0 },
          { time: '2026-09-11T22:00:01.000Z', latitude: 40.0, longitude: -83.0 },
        ],
      },
    } as never);
    expect(alertJobs.some((j) => j.name === 'alert.geofence_enter')).toBe(true);
  });

  it('§20 B-15 — raises alert.geofence_dwell once the vehicle has been inside long enough', async () => {
    const dwellFence = { ...fence, alertOnEnter: false, alertOnExit: false, dwellMinutes: 30 };
    const { processor, alertJobs, prisma } = buildProcessor([dwellFence]);
    // Already inside for 40 minutes by the time this batch's last point lands.
    prisma.telemetryPoint.findMany = jest.fn(async () => [
      { time: new Date('2026-09-11T00:39:00.000Z'), latitude: 40.0, longitude: -83.0 },
      { time: new Date('2026-09-11T00:00:00.000Z'), latitude: 40.0, longitude: -83.0 },
    ]);
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [{ time: '2026-09-11T00:40:00.000Z', latitude: 40.0, longitude: -83.0 }],
      },
    } as never);
    expect(alertJobs.some((j) => j.name === 'alert.geofence_dwell')).toBe(true);
  });

  it('§20 B-15 — no dwell alert while still under the threshold', async () => {
    const dwellFence = { ...fence, alertOnEnter: false, alertOnExit: false, dwellMinutes: 30 };
    const { processor, alertJobs, prisma } = buildProcessor([dwellFence]);
    prisma.telemetryPoint.findMany = jest.fn(async () => [
      { time: new Date('2026-09-11T00:10:00.000Z'), latitude: 40.0, longitude: -83.0 },
    ]);
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [{ time: '2026-09-11T00:10:00.000Z', latitude: 40.0, longitude: -83.0 }],
      },
    } as never);
    expect(alertJobs.some((j) => j.name === 'alert.geofence_dwell')).toBe(false);
  });

  describe('§20 B-104 — vehicle-group scoping', () => {
    const crossing = {
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: [
          { time: '2026-09-11T00:00:00.000Z', latitude: 41.0, longitude: -83.0 },
          { time: '2026-09-11T00:00:01.000Z', latitude: 40.0, longitude: -83.0 },
        ],
      },
    } as never;
    const entered = (jobs: Array<{ name: string }>) => jobs.some((j) => j.name === 'alert.geofence_enter');

    it('fires a fence whose group matches the vehicle group', async () => {
      const { processor, alertJobs } = buildProcessor([{ ...fence, vehicleGroupId: 'grp_a' }], 'grp_a');
      await processor.process(crossing);
      expect(entered(alertJobs)).toBe(true);
    });

    it('does not fire a fence scoped to a different group', async () => {
      const { processor, alertJobs } = buildProcessor([{ ...fence, vehicleGroupId: 'grp_b' }], 'grp_a');
      await processor.process(crossing);
      expect(entered(alertJobs)).toBe(false);
    });

    it('fires a null-group fence for any vehicle without looking up the vehicle', async () => {
      const { processor, alertJobs, prisma } = buildProcessor([{ ...fence, vehicleGroupId: null }], 'grp_a');
      await processor.process(crossing);
      expect(entered(alertJobs)).toBe(true);
      expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
    });

    it('a vehicle with no group only matches null-group fences', async () => {
      const { processor, alertJobs, prisma } = buildProcessor(
        [
          { ...fence, id: 'gf_scoped', vehicleGroupId: 'grp_a' },
          { ...fence, id: 'gf_all', vehicleGroupId: null },
        ],
        null,
      );
      await processor.process(crossing);
      const ids = alertJobs
        .filter((j) => j.name === 'alert.geofence_enter')
        .map((j) => (j.data as { geofenceId: string }).geofenceId);
      expect(ids).toEqual(['gf_all']);
      expect(prisma.vehicle.findUnique).toHaveBeenCalledTimes(1);
    });
  });
});

describe('SafetyDetectProcessor — PT SDK 6.11 (D-135, B-155)', () => {
  const brake = [
    { time: '2026-09-11T00:00:00.000Z', latitude: 40.123456, longitude: -83.123456, speedKmh: 80 },
    { time: '2026-09-11T00:00:01.000Z', latitude: 40.123456, longitude: -83.123456, speedKmh: 40 },
  ];

  it('stores a coarsened SafetyEvent position, never the raw fix', async () => {
    const { processor, createManyCalls } = buildProcessor();
    await processor.process({ data: { vehicleId: 'veh_1', driverId: 'drv_1', points: brake } } as never);
    const row = createManyCalls[0] as { latitude: number; longitude: number };
    expect(row.latitude).not.toBe(40.123456);
    expect(row.longitude).not.toBe(-83.123456);
  });

  it('skips the speed-delta proxy for a type the device detects itself', async () => {
    const { processor, createManyCalls } = buildProcessor();
    await processor.process({
      data: { vehicleId: 'veh_1', driverId: 'drv_1', deviceHarsh: { accel: false, brake: true, corner: false }, points: brake },
    } as never);
    expect(createManyCalls).toHaveLength(0);
  });

  it('detects harsh events on fix-less points and leaves the position null; geofences skip them', async () => {
    const fence = { id: 'g1', centerLat: 40, centerLon: -83, radiusMi: 1, alertOnEnter: true, alertOnExit: true, afterHoursOnly: false, dwellMinutes: null };
    const { processor, createManyCalls, prisma } = buildProcessor([fence]);
    await processor.process({
      data: {
        vehicleId: 'veh_1',
        driverId: 'drv_1',
        points: brake.map((p) => ({ ...p, latitude: null, longitude: null })),
      },
    } as never);
    expect(createManyCalls[0]).toMatchObject({ type: 'HARSH_BRAKING', latitude: null, longitude: null });
    expect(prisma.telemetryPoint.findFirst).not.toHaveBeenCalled();
  });
});

