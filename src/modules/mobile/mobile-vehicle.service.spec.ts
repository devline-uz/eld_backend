import type { AuditRepository } from '../audit/audit.repository';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileVehicleService } from './mobile-vehicle.service';

const ACTOR = { id: 'drv_1', type: 'driver' as const };

function build() {
  const repo = {
    findAvailableVehicles: jest.fn(),
    findVehicleWithDevice: jest.fn(),
    findVehicleHolder: jest.fn(),
    assignVehicle: jest.fn(),
  };
  const audit = { insert: jest.fn().mockResolvedValue(undefined) };
  const service = new MobileVehicleService(repo as unknown as MobileFleetOpsRepository, audit as unknown as AuditRepository);
  return { service, repo, audit };
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
  device: { serial: 'PT30-1' },
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
    });
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'DRIVER_VEHICLE_SELECTED', objectId: 'drv_1' }));
  });

  it('allows re-selecting a unit the driver already holds (no stale-holder clear)', async () => {
    const { service, repo } = build();
    repo.findVehicleWithDevice.mockResolvedValue(VEHICLE);
    repo.findVehicleHolder.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE' });
    repo.assignVehicle.mockResolvedValue({});

    await service.select('drv_1', { vehicleId: 'veh_1' }, ACTOR);
    expect(repo.assignVehicle).toHaveBeenCalledWith('drv_1', 'veh_1', null);
  });
});
