import type { AuditRepository } from '../audit/audit.repository';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileRepository } from './mobile.repository';
import { MobileVehicleService } from './mobile-vehicle.service';
import type { RodsLoginRecorder } from '../logs/rods-login-recorder';

const ACTOR = { id: 'drv_1', type: 'driver' as const };

function build() {
  const repo = {
    findAvailableVehicles: jest.fn(),
    findVehicleWithDevice: jest.fn(),
    findVehicleHolder: jest.fn(),
    assignVehicle: jest.fn(),
    releaseVehicle: jest.fn(),
  };
  const mobileRepo = {
    findDriver: jest.fn(),
    findActivePairing: jest.fn().mockResolvedValue(null),
    findSyncedByClientId: jest.fn().mockResolvedValue(null),
    recordSyncedResult: jest.fn().mockResolvedValue({ status: 'ACCEPTED', errorCode: null }),
  };
  const audit = { insert: jest.fn().mockResolvedValue(undefined) };
  const loginRecords = { login: jest.fn().mockResolvedValue(1), logout: jest.fn().mockResolvedValue(1) };
  const service = new MobileVehicleService(
    repo as unknown as MobileFleetOpsRepository,
    audit as unknown as AuditRepository,
    mobileRepo as unknown as MobileRepository,
    loginRecords as unknown as RodsLoginRecorder,
  );
  return { service, repo, audit, mobileRepo, loginRecords };
}

const VEHICLE = {
  id: 'veh_1',
  unitNumber: '104',
  vin: '1FUJA6CV71LM12345',
  make: 'Freightliner',
  model: 'Cascadia',
  year: 2021,
  sleeperBerth: true,
  status: 'ACTIVE',
  odometerMi: 1000,
  device: { id: 'dev_1', serial: 'PT30-1', model: 'PT30' },
};

describe('MobileVehicleService (MB-2)', () => {
  it('lists available vehicles with the slim M-03 shape', async () => {
    const { service, repo } = build();
    repo.findAvailableVehicles.mockResolvedValue([VEHICLE]);
    const result = await service.availableVehicles('drv_1');
    expect(result).toEqual([{ id: 'veh_1', unitNumber: '104', make: 'Freightliner', model: 'Cascadia', deviceSerial: 'PT30-1' }]);
  });

  it('404s VEHICLE_NOT_FOUND when the unit does not exist', async () => {
    const { service, repo } = build();
    repo.findVehicleWithDevice.mockResolvedValue(null);
    await expect(service.select('drv_1', { vehicleId: 'veh_x' }, ACTOR)).rejects.toMatchObject({ code: 'VEHICLE_NOT_FOUND', status: 404 });
  });

  it('422s VEHICLE_OUT_OF_SERVICE for an OOS unit', async () => {
    const { service, repo } = build();
    repo.findVehicleWithDevice.mockResolvedValue({ ...VEHICLE, status: 'OUT_OF_SERVICE' });
    await expect(service.select('drv_1', { vehicleId: 'veh_1' }, ACTOR)).rejects.toMatchObject({ code: 'VEHICLE_OUT_OF_SERVICE', status: 422 });
  });

  it('409s when another ACTIVE driver already holds the unit', async () => {
    const { service, repo } = build();
    repo.findVehicleWithDevice.mockResolvedValue(VEHICLE);
    repo.findVehicleHolder.mockResolvedValue({ id: 'drv_2', status: 'ACTIVE' });
    await expect(service.select('drv_1', { vehicleId: 'veh_1' }, ACTOR)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(repo.assignVehicle).not.toHaveBeenCalled();
  });

  it('reassigns and clears a stale INACTIVE holder, returning the bootstrap vehicle shape', async () => {
    const { service, repo, audit } = build();
    repo.findVehicleWithDevice.mockResolvedValue(VEHICLE);
    repo.findVehicleHolder.mockResolvedValue({ id: 'drv_2', status: 'INACTIVE' });
    repo.assignVehicle.mockResolvedValue({});

    const result = await service.select('drv_1', { vehicleId: 'veh_1' }, ACTOR);

    expect(repo.assignVehicle).toHaveBeenCalledWith('drv_1', 'veh_1', 'drv_2');
    expect(result).toEqual({
      id: 'veh_1',
      unitNumber: '104',
      vin: '1FUJA6CV71LM12345',
      make: 'Freightliner',
      model: 'Cascadia',
      year: 2021,
      sleeperBerth: true,
      status: 'ACTIVE',
      odometerMi: 1000,
      device: { id: 'dev_1', serial: 'PT30-1', model: 'PT30' },
    });
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'DRIVER_VEHICLE_SELECTED', objectId: 'drv_1' }));
  });

  it('D-130: select writes the §395 login on the unit and closes the replaced stale holder\'s login', async () => {
    const { service, repo, loginRecords } = build();
    repo.findVehicleWithDevice.mockResolvedValue(VEHICLE);
    repo.findVehicleHolder.mockResolvedValue({ id: 'drv_2', status: 'INACTIVE' });
    repo.assignVehicle.mockResolvedValue({});
    await service.select('drv_1', { vehicleId: 'veh_1' }, ACTOR);
    expect(loginRecords.logout).toHaveBeenCalledWith('drv_2', 'STALE_HOLDER_REPLACED', { onlyVehicleId: 'veh_1' });
    expect(loginRecords.login).toHaveBeenCalledWith('drv_1', 'veh_1', 'SELECT_VEHICLE');
  });

  it('allows re-selecting a unit the driver already holds (no stale-holder clear)', async () => {
    const { service, repo } = build();
    repo.findVehicleWithDevice.mockResolvedValue(VEHICLE);
    repo.findVehicleHolder.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE' });
    repo.assignVehicle.mockResolvedValue({});

    await service.select('drv_1', { vehicleId: 'veh_1' }, ACTOR);
    expect(repo.assignVehicle).toHaveBeenCalledWith('drv_1', 'veh_1', null);
  });

  it('MR-21: select() returns the bound device, null when none', async () => {
    const { service, repo } = build();
    repo.findVehicleWithDevice.mockResolvedValue(VEHICLE);
    repo.findVehicleHolder.mockResolvedValue(null);
    expect(await service.select('drv_1', { vehicleId: 'veh_1' }, ACTOR)).toMatchObject({
      device: { id: 'dev_1', serial: 'PT30-1', model: 'PT30' },
    });
    repo.findVehicleWithDevice.mockResolvedValue({ ...VEHICLE, device: null });
    expect(await service.select('drv_1', { vehicleId: 'veh_1' }, ACTOR)).toMatchObject({ device: null });
  });

  it('MR-32: passes q/limit through to the repository', async () => {
    const { service, repo } = build();
    repo.findAvailableVehicles.mockResolvedValue([]);
    await service.availableVehicles('drv_1', { q: '10', limit: 5 });
    expect(repo.findAvailableVehicles).toHaveBeenCalledWith('drv_1', { q: '10', limit: 5 });
  });

  describe('release (MR-2)', () => {
    it('409 NO_ASSIGNED_VEHICLE when the driver holds no unit', async () => {
      const { service, mobileRepo, repo } = build();
      mobileRepo.findDriver.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null });
      await expect(service.release('drv_1', {}, ACTOR)).rejects.toMatchObject({ code: 'NO_ASSIGNED_VEHICLE', status: 409 });
      expect(repo.releaseVehicle).not.toHaveBeenCalled();
    });

    it('clears the unit, ends a pairing on that unit and records the clientId', async () => {
      const { service, mobileRepo, repo, loginRecords } = build();
      mobileRepo.findDriver.mockResolvedValue({ id: 'drv_1', assignedVehicleId: 'veh_1' });
      mobileRepo.findActivePairing.mockResolvedValue({ id: 'pair_1', vehicleId: 'veh_1' });
      const result = await service.release('drv_1', { clientId: 'c-1', reason: 'done' }, ACTOR);
      expect(result).toEqual({ released: true, vehicleId: 'veh_1' });
      expect(repo.releaseVehicle).toHaveBeenCalledWith('drv_1', 'pair_1', expect.any(Date));
      expect(loginRecords.logout).toHaveBeenCalledWith('drv_1', 'RELEASE_VEHICLE', { onlyVehicleId: 'veh_1' });
      expect(mobileRepo.recordSyncedResult).toHaveBeenCalledWith('drv_1', 'c-1', 'release_vehicle', expect.any(Date), 'ACCEPTED', null, result);
    });

    it('replay with the same clientId returns the first answer, no 409 and no second write', async () => {
      const { service, mobileRepo, repo } = build();
      mobileRepo.findSyncedByClientId.mockResolvedValue({ type: 'release_vehicle', status: 'ACCEPTED', result: { released: true, vehicleId: 'veh_1' } });
      mobileRepo.findDriver.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null });
      expect(await service.release('drv_1', { clientId: 'c-1' }, ACTOR)).toEqual({ released: true, vehicleId: 'veh_1' });
      expect(repo.releaseVehicle).not.toHaveBeenCalled();
    });

    it('a clientId already used by another ledger operation is 409, never that operation\'s result', async () => {
      const { service, mobileRepo, repo } = build();
      mobileRepo.findSyncedByClientId.mockResolvedValue({ type: 'create_conversation', status: 'ACCEPTED', result: { conversationId: 'cnv_1' } });
      mobileRepo.findDriver.mockResolvedValue({ id: 'drv_1', assignedVehicleId: 'veh_1' });
      await expect(service.release('drv_1', { clientId: 'c-1' }, ACTOR)).rejects.toMatchObject({ status: 409 });
      expect(repo.releaseVehicle).not.toHaveBeenCalled();
    });

    it('keeps a pairing that is on a different unit', async () => {
      const { service, mobileRepo, repo } = build();
      mobileRepo.findDriver.mockResolvedValue({ id: 'drv_1', assignedVehicleId: 'veh_1' });
      mobileRepo.findActivePairing.mockResolvedValue({ id: 'pair_9', vehicleId: 'veh_2' });
      await service.release('drv_1', {}, ACTOR);
      expect(repo.releaseVehicle).toHaveBeenCalledWith('drv_1', null, expect.any(Date));
    });
  });
});
