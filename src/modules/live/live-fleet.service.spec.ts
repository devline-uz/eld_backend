import 'reflect-metadata';
import { PERM_METADATA_KEY } from '../../common/decorators/perm.decorator';
import { LiveFleetController } from './live-fleet.controller';
import { FUTURE_TOLERANCE_MS, LIVE_FLEET_CACHE_MS, LIVE_FLEET_MAX_STALE_MS, LiveFleetService, serverTiming } from './live-fleet.service';

const NOW = new Date('2026-09-14T15:41:00.000Z');
const minsAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

const driver = {
  id: 'drv_1', firstName: 'John', lastName: 'Smith', phone: null, homeTerminalTimezone: 'America/New_York',
  passwordHash: 'never-serialized',
};

function setup() {
  const repo = {
    findVehicles: jest.fn().mockResolvedValue([
      { id: 'veh_110', unitNumber: '110', status: 'OUT_OF_SERVICE', odometerMi: 10, device: null, driver: null },
      {
        id: 'veh_101', unitNumber: '101', status: 'ACTIVE', odometerMi: 50_000,
        device: { serial: 'PT30_A86E', bleState: 'CONNECTED', lastSeenAt: minsAgo(1) }, driver,
      },
      {
        id: 'veh_104', unitNumber: '104', status: 'ACTIVE', odometerMi: 52_000,
        device: { serial: 'PT30_EE35', bleState: 'OUT_OF_RANGE', lastSeenAt: minsAgo(45) }, driver: null,
      },
    ]),
    latestTelemetry: jest.fn().mockResolvedValue(
      new Map([['veh_101', { time: minsAgo(2), fixTime: minsAgo(2), latitude: 38.99, longitude: -84.63, speedMph: 0, headingDeg: 90, odometerMi: 50_100, engineOn: false }]]),
    ),
    latestLocatedEvents: jest.fn().mockResolvedValue(new Map()),
    activeSpecialDriving: jest.fn().mockResolvedValue(new Map([['drv_1', 'PC']])),
    findAdverseInvokedToday: jest.fn().mockResolvedValue(new Set()),
  };
  const hos = {
    computeCurrentStates: jest.fn().mockResolvedValue(
      new Map([['drv_1', { currentStatus: 'OFF', driveRemainingSec: 39_600, shiftEndsAt: null }]]),
    ),
  };
  const service = new LiveFleetService(repo as never, hos as never);
  return { repo, hos, service };
}

describe('LiveFleetService.snapshot', () => {
  it('builds one row per vehicle, in natural unit order, and computes HOS only for assigned drivers', async () => {
    const { repo, hos, service } = setup();
    const res = await service.snapshot(NOW);

    expect(res.generatedAt).toBe(NOW.toISOString());
    expect(res.items.map((u) => [u.unitNumber, u.dutyStatus, u.bleState])).toEqual([
      ['101', 'PERSONAL_CONVEYANCE', 'CONNECTED'],
      ['104', 'ELD_OFFLINE', 'DISCONNECTED'],
      ['110', 'INACTIVE', null],
    ]);
    expect(res.items[0]).toMatchObject({ driverName: 'John Smith', lat: 38.99, driveRemainingSec: 39_600 });
    expect(JSON.stringify(res)).not.toContain('never-serialized');

    expect(hos.computeCurrentStates).toHaveBeenCalledWith([driver], NOW);
    const until = new Date(NOW.getTime() + FUTURE_TOLERANCE_MS);
    expect(repo.latestTelemetry).toHaveBeenCalledWith(['veh_110', 'veh_101', 'veh_104'], until, expect.any(Function));
    expect(repo.latestLocatedEvents).toHaveBeenCalledWith(['veh_110', 'veh_101', 'veh_104'], until, expect.any(Function));
    expect(repo.activeSpecialDriving).toHaveBeenCalledWith(['drv_1'], expect.any(Date), until);
  });

  it('serves repeated polls inside the 10 s window from one computation', async () => {
    const { repo, service } = setup();
    const [a, b] = await Promise.all([service.snapshot(NOW), service.snapshot(new Date(NOW.getTime() + 5_000))]);
    expect(a).toBe(b);
    expect(repo.findVehicles).toHaveBeenCalledTimes(1);
    await expect(service.read(at(LIVE_FLEET_CACHE_MS - 1))).resolves.toMatchObject({ snapshot: a, cache: 'fresh' });
    expect(repo.findVehicles).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure', async () => {
    const { repo, service } = setup();
    repo.findVehicles.mockRejectedValueOnce(new Error('db down'));
    await expect(service.snapshot(NOW)).rejects.toThrow('db down');
    await expect(service.snapshot(new Date(NOW.getTime() + 1_000))).resolves.toHaveProperty('items');
    expect(repo.findVehicles).toHaveBeenCalledTimes(2);
  });

  it('still returns positions when the HOS engine fails — clocks are omitted, status falls back', async () => {
    const { hos, service } = setup();
    hos.computeCurrentStates.mockRejectedValueOnce(new Error('engine'));
    const res = await service.snapshot(NOW);
    expect(res.items[0]).toMatchObject({ unitNumber: '101', lat: 38.99, driveRemainingSec: null, dutyStatus: 'OFF_DUTY' });
  });
});

/** A promise resolved/rejected from the test, to hold a build open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('LiveFleetService — completion-stamped stale-while-revalidate cache (LV-02)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stamps freshness at build COMPLETION: a 15 s build is still fresh for 10 s after it lands', async () => {
    const { repo, service } = setup();
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const vehicles = deferred<unknown[]>();
    const rows = (await repo.findVehicles()) as unknown[];
    repo.findVehicles.mockClear();
    repo.findVehicles.mockReturnValueOnce(vehicles.promise);

    const first = service.read(NOW);
    clock = 15_000; // the build takes 15 s of wall time
    vehicles.resolve(rows);
    const built = await first;
    expect(built.cache).toBe('miss');
    expect(built.snapshot.generatedAt).toBe(NOW.toISOString()); // as-of instant, not completion
    expect(built.phases.total).toBe(15_000);

    // The old start-stamped cache had expired at NOW+10 s, before this build even landed.
    const detail = await service.read(at(15_000 + LIVE_FLEET_CACHE_MS - 1));
    expect(detail).toMatchObject({ cache: 'fresh', ageMs: LIVE_FLEET_CACHE_MS - 1 });
    expect(detail.snapshot).toBe(built.snapshot);
    expect(repo.findVehicles).toHaveBeenCalledTimes(1);
  });

  it('serves a stale snapshot at once and refreshes it in the background with ONE build', async () => {
    const { repo, service } = setup();
    const old = await service.snapshot(NOW);
    const next = deferred<unknown[]>();
    const rows = (await repo.findVehicles()) as unknown[];
    repo.findVehicles.mockClear();
    repo.findVehicles.mockReturnValueOnce(next.promise);

    const stale = await service.read(at(LIVE_FLEET_CACHE_MS + 1_000));
    expect(stale).toMatchObject({ cache: 'stale', snapshot: old });
    expect(stale.snapshot.generatedAt).toBe(NOW.toISOString());
    // More polls (list + detail) while the rebuild runs: same old snapshot, no second build.
    await expect(service.unit('veh_101', at(LIVE_FLEET_CACHE_MS + 2_000))).resolves.toMatchObject({ vehicleId: 'veh_101' });
    await expect(service.snapshot(at(LIVE_FLEET_CACHE_MS + 3_000))).resolves.toBe(old);
    expect(repo.findVehicles).toHaveBeenCalledTimes(1);

    next.resolve(rows);
    await flush();
    const fresh = await service.read(at(LIVE_FLEET_CACHE_MS + 4_000));
    expect(fresh.cache).toBe('fresh');
    expect(fresh.snapshot).not.toBe(old);
    expect(fresh.snapshot.generatedAt).toBe(at(LIVE_FLEET_CACHE_MS + 1_000).toISOString());
    expect(repo.findVehicles).toHaveBeenCalledTimes(1);
  });

  it('waits for a fresh build once the snapshot is older than the max staleness', async () => {
    const { repo, service } = setup();
    const old = await service.snapshot(NOW);
    const res = await service.read(at(LIVE_FLEET_MAX_STALE_MS + 1_000));
    expect(res.cache).toBe('miss');
    expect(res.snapshot).not.toBe(old);
    expect(res.snapshot.generatedAt).toBe(at(LIVE_FLEET_MAX_STALE_MS + 1_000).toISOString());
    expect(repo.findVehicles).toHaveBeenCalledTimes(2);
  });

  it('cold start: concurrent callers share one build', async () => {
    const { repo, service } = setup();
    const [a, b, c] = await Promise.all([service.read(NOW), service.read(at(1)), service.unit('veh_101', at(2))]);
    expect(a.snapshot).toBe(b.snapshot);
    expect(c.vehicleId).toBe('veh_101');
    expect(repo.findVehicles).toHaveBeenCalledTimes(1);
  });

  it('a failed background refresh keeps the previous snapshot and is retried by the next read', async () => {
    const { repo, service } = setup();
    const old = await service.snapshot(NOW);
    repo.findVehicles.mockRejectedValueOnce(new Error('db down'));
    await expect(service.read(at(LIVE_FLEET_CACHE_MS + 1_000))).resolves.toMatchObject({ cache: 'stale', snapshot: old });
    await flush();
    expect(repo.findVehicles).toHaveBeenCalledTimes(2);

    await expect(service.read(at(LIVE_FLEET_CACHE_MS + 2_000))).resolves.toMatchObject({ cache: 'stale', snapshot: old });
    await flush();
    expect(repo.findVehicles).toHaveBeenCalledTimes(3);
    await expect(service.read(at(LIVE_FLEET_CACHE_MS + 3_000))).resolves.toMatchObject({ cache: 'fresh' });
  });

  it('a failed build past the max staleness reaches the caller (nothing stale is served)', async () => {
    const { repo, service } = setup();
    await service.snapshot(NOW);
    repo.findVehicles.mockRejectedValueOnce(new Error('db down'));
    await expect(service.read(at(LIVE_FLEET_MAX_STALE_MS + 1_000))).rejects.toThrow('db down');
  });

  it('records each phase, including the probe passes reported by the repository', async () => {
    const { repo, service } = setup();
    repo.latestLocatedEvents.mockImplementationOnce(async (_ids: string[], _until: Date, timer: (p: string, ms: number, n: number) => void) => {
      timer('located.recent', 3, 3);
      timer('located.fallback', 20, 2);
      return new Map();
    });
    const res = await service.read(NOW);
    expect(Object.keys(res.phases)).toEqual(expect.arrayContaining(['vehicles', 'adverse', 'telemetry', 'located', 'located.recent', 'located.fallback', 'special', 'hos', 'map', 'total']));
    expect(res.units).toEqual({ 'located.recent': 3, 'located.fallback': 2 });
  });
});

describe('serverTiming', () => {
  it('formats cache state, age and every phase (total as app)', () => {
    expect(
      serverTiming({
        snapshot: { items: [], generatedAt: 'x' },
        cache: 'stale',
        ageMs: 12_345.6,
        phases: { vehicles: 4.2, 'located.fallback': 25_000, total: 25_010 },
        units: { 'located.fallback': 27 },
      }),
    ).toBe('cache;desc="stale", age;dur=12346, vehicles;dur=4.2, located-fallback;dur=25000;desc="27 units", app;dur=25010');
  });
});

describe('LiveFleetService.unit', () => {
  it('returns the full row for one unit from the shared cached snapshot', async () => {
    const { repo, service } = setup();
    await service.snapshot(NOW);
    const unit = await service.unit('veh_101', new Date(NOW.getTime() + 1_000));
    expect(unit).toMatchObject({ vehicleId: 'veh_101', unitNumber: '101', driveRemainingSec: 39_600, eldSerial: 'PT30_A86E', odometerMi: 50_100 });
    expect(repo.findVehicles).toHaveBeenCalledTimes(1);
  });

  it('is a VEHICLE_NOT_FOUND 404 for a unit outside the snapshot (unknown or deleted)', async () => {
    const { service } = setup();
    await expect(service.unit('veh_nope', NOW)).rejects.toMatchObject({ status: 404, code: 'VEHICLE_NOT_FOUND' });
  });
});

describe('LiveFleetService — invalid stored timezone (BE-003)', () => {
  it('leaves the bad driver out of the HOS batch instead of losing every unit\'s clocks', async () => {
    const { repo, hos, service } = setup();
    const bad = { ...driver, id: 'drv_bad', homeTerminalTimezone: 'Nowhere/Land' };
    const vehicles = (await repo.findVehicles()) as object[];
    repo.findVehicles.mockClear();
    repo.findVehicles.mockResolvedValueOnce([...vehicles, { id: 'veh_200', unitNumber: '200', status: 'ACTIVE', odometerMi: 1, device: null, driver: bad }]);
    const res = await service.snapshot(NOW);
    expect(hos.computeCurrentStates).toHaveBeenCalledWith([driver], NOW);
    expect(res.items.find((u) => u.unitNumber === '101')).toMatchObject({ driveRemainingSec: 39_600 });
    expect(res.items.find((u) => u.unitNumber === '200')).toMatchObject({ driveRemainingSec: null });
  });
});

const readOf = (items: object[]) => ({
  snapshot: { items, generatedAt: 'x' }, cache: 'fresh', ageMs: 5, phases: { vehicles: 1, total: 2 }, units: {},
});

describe('LiveFleetController', () => {
  it('GET /live/fleet requires liveFleet:READ and delegates to the service', async () => {
    expect(Reflect.getMetadata(PERM_METADATA_KEY, LiveFleetController.prototype.fleet)).toEqual({ key: 'liveFleet', level: 'READ' });
    expect(Reflect.getMetadata('path', LiveFleetController)).toBe('live');
    expect(Reflect.getMetadata('path', LiveFleetController.prototype.fleet)).toBe('fleet');
    const live = { read: jest.fn().mockResolvedValue(readOf([])) };
    await expect(new LiveFleetController(live as never).fleet()).resolves.toEqual({ items: [], generatedAt: 'x' });
  });

  it('LV-02 — sets Server-Timing on the list and on the detail read', async () => {
    const live = { read: jest.fn().mockResolvedValue(readOf([{ vehicleId: 'v', driverPhone: null }])), unitOf: (s: { items: unknown[] }) => s.items[0] };
    const ctl = new LiveFleetController(live as never);
    const res = { setHeader: jest.fn() };
    await ctl.fleet(undefined, { view: 'list' }, res as never);
    await ctl.unit('v', undefined, res as never);
    expect(res.setHeader).toHaveBeenCalledTimes(2);
    expect(res.setHeader).toHaveBeenCalledWith('Server-Timing', 'cache;desc="fresh", age;dur=5, vehicles;dur=1, app;dur=2');
  });

  it('?view=list returns slim rows without the detail-card-only fields; default stays full', async () => {
    const row = { vehicleId: 'v', unitNumber: '1', driverPhone: '+1 555', odometerMi: 1, driveRemainingSec: 2, shiftEndsAt: 'x', eldSerial: 'S', dutyStatus: 'DRIVING', bleState: 'CONNECTED' };
    const live = { read: jest.fn().mockResolvedValue(readOf([row])) };
    const ctl = new LiveFleetController(live as never);
    const reader = { permissions: { liveFleet: 'READ', drivers: 'READ' } } as never;
    await expect(ctl.fleet(reader, { view: 'list' })).resolves.toEqual({
      items: [{ vehicleId: 'v', unitNumber: '1', dutyStatus: 'DRIVING', bleState: 'CONNECTED' }],
      generatedAt: 'x',
    });
    await expect(ctl.fleet(reader, { view: 'full' })).resolves.toEqual({ items: [row], generatedAt: 'x' });
    await expect(ctl.fleet(reader)).resolves.toEqual({ items: [row], generatedAt: 'x' });
  });

  it('GET /live/fleet/:vehicleId requires liveFleet:READ, returns the full row and hides driverPhone without drivers READ', async () => {
    expect(Reflect.getMetadata(PERM_METADATA_KEY, LiveFleetController.prototype.unit)).toEqual({ key: 'liveFleet', level: 'READ' });
    expect(Reflect.getMetadata('path', LiveFleetController.prototype.unit)).toBe('fleet/:vehicleId');
    const row = { vehicleId: 'v', driverPhone: '+1 555', driveRemainingSec: 60, shiftEndsAt: 'x', eldSerial: 'S', odometerMi: 9 };
    const unitOf = jest.fn().mockReturnValue(row);
    const live = { read: jest.fn().mockResolvedValue(readOf([row])), unitOf };
    const ctl = new LiveFleetController(live as never);
    const viewer = { permissions: { liveFleet: 'READ' } } as never;
    const reader = { permissions: { liveFleet: 'READ', drivers: 'READ' } } as never;
    await expect(ctl.unit('v', reader)).resolves.toEqual(row);
    await expect(ctl.unit('v', viewer)).resolves.toEqual({ ...row, driverPhone: null });
    expect(unitOf).toHaveBeenCalledWith({ items: [row], generatedAt: 'x' }, 'v');
  });

  it('GET /live/fleet/:vehicleId propagates the 404 for an unknown unit', async () => {
    const { service } = setup();
    const ctl = new LiveFleetController(service);
    await expect(ctl.unit('veh_nope')).rejects.toMatchObject({ status: 404 });
  });

  it('CODE-053 — hides driverPhone without drivers READ', async () => {
    const live = { read: jest.fn().mockResolvedValue(readOf([{ vehicleId: 'v', driverPhone: '+1 555' }])) };
    const ctl = new LiveFleetController(live as never);
    const viewer = { permissions: { liveFleet: 'READ' } } as never;
    const reader = { permissions: { liveFleet: 'READ', drivers: 'READ' } } as never;
    await expect(ctl.fleet(viewer)).resolves.toMatchObject({ items: [{ driverPhone: null }] });
    await expect(ctl.fleet(reader)).resolves.toMatchObject({ items: [{ driverPhone: '+1 555' }] });
  });
});
