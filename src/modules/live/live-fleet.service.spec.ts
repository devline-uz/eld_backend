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
      new Map([['veh_101', { time: minsAgo(2), latitude: 38.99, longitude: -84.63, speedMph: 0, headingDeg: 90, odometerMi: 50_100, engineOn: false }]]),
    ),
    latestLocatedEvents: jest.fn().mockResolvedValue(new Map()),
    activeSpecialDriving: jest.fn().mockResolvedValue(new Map([['drv_1', 'PC']])),
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

describe('LiveFleetController', () => {
  it('GET /live/fleet requires liveFleet:READ and delegates to the service', async () => {
    expect(Reflect.getMetadata(PERM_METADATA_KEY, LiveFleetController.prototype.fleet)).toEqual({ key: 'liveFleet', level: 'READ' });
    expect(Reflect.getMetadata('path', LiveFleetController)).toBe('live');
    expect(Reflect.getMetadata('path', LiveFleetController.prototype.fleet)).toBe('fleet');
    const live = { snapshot: jest.fn().mockResolvedValue({ items: [], generatedAt: 'x' }) };
    await expect(new LiveFleetController(live as never).fleet()).resolves.toEqual({ items: [], generatedAt: 'x' });
  });
});
