import 'reflect-metadata';
import { PERM_METADATA_KEY } from '../../common/decorators/perm.decorator';
import { LiveFleetController } from './live-fleet.controller';
import { FUTURE_TOLERANCE_MS, LIVE_FLEET_CACHE_MS, LiveFleetService } from './live-fleet.service';

const NOW = new Date('2026-09-14T15:41:00.000Z');
const minsAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

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
    expect(repo.latestTelemetry).toHaveBeenCalledWith(['veh_110', 'veh_101', 'veh_104'], until);
    expect(repo.latestLocatedEvents).toHaveBeenCalledWith(['veh_110', 'veh_101', 'veh_104'], until);
    expect(repo.activeSpecialDriving).toHaveBeenCalledWith(['drv_1'], expect.any(Date), until);
  });

  it('serves repeated polls inside the 10 s window from one computation, then refreshes', async () => {
    const { repo, service } = setup();
    const [a, b] = await Promise.all([service.snapshot(NOW), service.snapshot(new Date(NOW.getTime() + 5_000))]);
    expect(a).toBe(b);
    expect(repo.findVehicles).toHaveBeenCalledTimes(1);

    await service.snapshot(new Date(NOW.getTime() + LIVE_FLEET_CACHE_MS));
    expect(repo.findVehicles).toHaveBeenCalledTimes(2);
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

describe('LiveFleetController', () => {
  it('GET /live/fleet requires liveFleet:READ and delegates to the service', async () => {
    expect(Reflect.getMetadata(PERM_METADATA_KEY, LiveFleetController.prototype.fleet)).toEqual({ key: 'liveFleet', level: 'READ' });
    expect(Reflect.getMetadata('path', LiveFleetController)).toBe('live');
    expect(Reflect.getMetadata('path', LiveFleetController.prototype.fleet)).toBe('fleet');
    const live = { snapshot: jest.fn().mockResolvedValue({ items: [], generatedAt: 'x' }) };
    await expect(new LiveFleetController(live as never).fleet()).resolves.toEqual({ items: [], generatedAt: 'x' });
  });

  it('?view=list returns slim rows without the detail-card-only fields; default stays full', async () => {
    const row = { vehicleId: 'v', unitNumber: '1', driverPhone: '+1 555', odometerMi: 1, driveRemainingSec: 2, shiftEndsAt: 'x', eldSerial: 'S', dutyStatus: 'DRIVING', bleState: 'CONNECTED' };
    const live = { snapshot: jest.fn().mockResolvedValue({ items: [row], generatedAt: 'x' }) };
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
    const live = { unit: jest.fn().mockResolvedValue(row) };
    const ctl = new LiveFleetController(live as never);
    const viewer = { permissions: { liveFleet: 'READ' } } as never;
    const reader = { permissions: { liveFleet: 'READ', drivers: 'READ' } } as never;
    await expect(ctl.unit('v', reader)).resolves.toEqual(row);
    await expect(ctl.unit('v', viewer)).resolves.toEqual({ ...row, driverPhone: null });
    expect(live.unit).toHaveBeenCalledWith('v');
  });

  it('GET /live/fleet/:vehicleId propagates the 404 for an unknown unit', async () => {
    const { service } = setup();
    const ctl = new LiveFleetController(service);
    await expect(ctl.unit('veh_nope')).rejects.toMatchObject({ status: 404 });
  });

  it('CODE-053 — hides driverPhone without drivers READ', async () => {
    const live = { snapshot: jest.fn().mockResolvedValue({ items: [{ vehicleId: 'v', driverPhone: '+1 555' }], generatedAt: 'x' }) };
    const ctl = new LiveFleetController(live as never);
    const viewer = { permissions: { liveFleet: 'READ' } } as never;
    const reader = { permissions: { liveFleet: 'READ', drivers: 'READ' } } as never;
    await expect(ctl.fleet(viewer)).resolves.toMatchObject({ items: [{ driverPhone: null }] });
    await expect(ctl.fleet(reader)).resolves.toMatchObject({ items: [{ driverPhone: '+1 555' }] });
  });
});
