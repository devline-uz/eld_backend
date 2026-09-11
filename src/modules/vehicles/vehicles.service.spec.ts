import { AppException } from '../../common/errors/app.exception';
import { DriversRepository } from '../drivers/drivers.repository';
import { VehiclesRepository } from './vehicles.repository';
import { VehiclesService } from './vehicles.service';

function makeVehicle(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'veh_1',
    unitNumber: '#101',
    vin: '1FUJA6CV88LW12345',
    status: 'ACTIVE',
    odometerMi: 23100,
    deviceOdometerMi: null,
    odometerOffsetMi: 0,
    odometerCalibratedAt: null,
    ...overrides,
  };
}

describe('VehiclesService', () => {
  let vehiclesRepo: jest.Mocked<Pick<VehiclesRepository, 'findById' | 'update' | 'findByUnitNumber' | 'findByVin' | 'list' | 'listAll' | 'create' | 'delete'>>;
  let driversRepo: jest.Mocked<Pick<DriversRepository, 'findById' | 'update' | 'findOne'>>;
  let service: VehiclesService;

  beforeEach(() => {
    vehiclesRepo = {
      findById: jest.fn(),
      update: jest.fn(),
      findByUnitNumber: jest.fn(),
      findByVin: jest.fn(),
      list: jest.fn(),
      listAll: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    };
    driversRepo = {
      findById: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn(),
    };
    service = new VehiclesService(vehiclesRepo as unknown as VehiclesRepository, driversRepo as unknown as DriversRepository);
  });

  describe('calibrateOdometer (TZ §4.3 step 4)', () => {
    it('records the dash value without touching the offset when there is no device reading yet', async () => {
      const vehicle = makeVehicle();
      vehiclesRepo.findById.mockResolvedValue(vehicle as never);
      vehiclesRepo.update.mockImplementation((_where, data) => Promise.resolve({ ...vehicle, ...data } as never));

      await service.calibrateOdometer('veh_1', { odometerMi: 23200 });

      expect(vehiclesRepo.update).toHaveBeenCalledWith({ id: 'veh_1' }, { odometerMi: 23200 });
    });

    it('recomputes the offset from the true value minus the last device reading', async () => {
      const vehicle = makeVehicle({ deviceOdometerMi: 5056 });
      vehiclesRepo.findById.mockResolvedValue(vehicle as never);
      vehiclesRepo.update.mockImplementation((_where, data) => Promise.resolve({ ...vehicle, ...data } as never));

      await service.calibrateOdometer('veh_1', { odometerMi: 23100 });

      const expectedCalibratedAt: unknown = expect.any(Date);
      expect(vehiclesRepo.update).toHaveBeenCalledWith(
        { id: 'veh_1' },
        expect.objectContaining({ odometerMi: 23100, odometerOffsetMi: 18044, odometerCalibratedAt: expectedCalibratedAt }),
      );
    });
  });

  describe('assignDriver — out-of-service hard rule', () => {
    it('blocks assignment when the vehicle is OUT_OF_SERVICE', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);

      await expect(service.assignDriver('veh_1', { driverId: 'drv_1' })).rejects.toThrow(AppException);
      expect(driversRepo.update).not.toHaveBeenCalled();
    });

    it('assigns the driver when the vehicle is ACTIVE', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1' });

      expect(driversRepo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { assignedVehicle: { connect: { id: 'veh_1' } } });
    });

    it('surfaces a conflict when the unit is already assigned to another driver', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null } as never);
      driversRepo.update.mockRejectedValue(new Error('Unique constraint failed'));

      await expect(service.assignDriver('veh_1', { driverId: 'drv_1' })).rejects.toThrow(AppException);
    });
  });

  describe('list / get', () => {
    it('list parses sort and returns an offset page', async () => {
      vehiclesRepo.list.mockResolvedValue({ items: [makeVehicle()], total: 1 } as never);
      const result = await service.list({ page: 1, limit: 20 });
      expect(vehiclesRepo.list).toHaveBeenCalledWith({ status: undefined, q: undefined }, 1, 20, { unitNumber: 'asc' });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('get throws VEHICLE_NOT_FOUND when missing', async () => {
      vehiclesRepo.findById.mockResolvedValue(null);
      await expect(service.get('missing')).rejects.toThrow(AppException);
    });

    it('get returns the vehicle when found', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      const result = await service.get('veh_1');
      expect(result.id).toBe('veh_1');
    });
  });

  describe('create', () => {
    it('throws conflict when unitNumber already exists', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      await expect(service.create({ unitNumber: '#101', vin: 'VIN' } as never)).rejects.toThrow(AppException);
    });

    it('throws conflict when VIN already exists', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(makeVehicle() as never);
      await expect(service.create({ unitNumber: '#101', vin: 'VIN' } as never)).rejects.toThrow(AppException);
    });

    it('creates when unique', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle() as never);
      const result = await service.create({
        unitNumber: '#101',
        vin: 'VIN',
        make: 'Freightliner',
        model: 'Cascadia',
        year: 2020,
        licensePlate: 'ABC123',
        plateState: 'OH',
        fuelType: 'DIESEL',
        sleeperBerth: true,
        odometerMi: 100,
        busType: undefined,
        notes: 'note',
      } as never);
      expect(result.id).toBe('veh_1');
      expect(vehiclesRepo.create).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('throws when the vehicle does not exist', async () => {
      vehiclesRepo.findById.mockResolvedValue(null);
      await expect(service.update('missing', {})).rejects.toThrow(AppException);
    });

    it('builds a partial update input from defined fields only', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ make: 'Volvo' }) as never);
      await service.update('veh_1', { make: 'Volvo', status: 'ACTIVE' } as never);
      expect(vehiclesRepo.update).toHaveBeenCalledWith({ id: 'veh_1' }, { make: 'Volvo', status: 'ACTIVE' });
    });
  });

  describe('unassignDriver', () => {
    it('disconnects the current driver when one is assigned', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findOne.mockResolvedValue({ id: 'drv_1' } as never);
      driversRepo.update.mockResolvedValue({} as never);
      await service.unassignDriver('veh_1');
      expect(driversRepo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { assignedVehicle: { disconnect: true } });
    });

    it('no-ops when no driver is assigned', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findOne.mockResolvedValue(null);
      await service.unassignDriver('veh_1');
      expect(driversRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('assignDriver — already assigned to same driver', () => {
    it('returns the vehicle without re-assigning', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: 'veh_1' } as never);
      const result = await service.assignDriver('veh_1', { driverId: 'drv_1' });
      expect(driversRepo.update).not.toHaveBeenCalled();
      expect(result.id).toBe('veh_1');
    });

    it('throws DRIVER_NOT_FOUND when driver does not exist', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue(null);
      await expect(service.assignDriver('veh_1', { driverId: 'missing' })).rejects.toThrow(AppException);
    });
  });

  describe('exportAll / importMany', () => {
    it('exportAll maps every vehicle to a CreateVehicleDto shape', async () => {
      vehiclesRepo.listAll.mockResolvedValue([makeVehicle({ make: null, model: null, year: null })] as never);
      const rows = await service.exportAll();
      expect(rows[0]).toEqual(
        expect.objectContaining({ unitNumber: '#101', vin: '1FUJA6CV88LW12345', make: undefined }),
      );
    });

    it('importMany creates new rows and updates existing ones, tolerating per-row failures', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValueOnce(null).mockResolvedValueOnce(makeVehicle() as never).mockResolvedValueOnce(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValueOnce(makeVehicle() as never).mockRejectedValueOnce(new Error('boom'));
      vehiclesRepo.update.mockResolvedValue(makeVehicle() as never);

      const summary = await service.importMany({
        vehicles: [
          { unitNumber: 'A', vin: 'VIN-A', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0 },
          { unitNumber: 'B', vin: 'VIN-B', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0 },
          { unitNumber: 'C', vin: 'VIN-C', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0 },
        ],
      } as never);

      expect(summary.imported).toBe(1);
      expect(summary.updated).toBe(1);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]).toEqual({ index: 2, error: 'boom' });
    });
  });

  describe('trueOdometerMi', () => {
    it('returns the dash value when there is no device reading', () => {
      expect(service.trueOdometerMi(makeVehicle({ deviceOdometerMi: null, odometerMi: 500 }) as never)).toBe(500);
    });

    it('applies the offset to the device reading when one exists', () => {
      const result = service.trueOdometerMi(makeVehicle({ deviceOdometerMi: 100, odometerOffsetMi: 50 }) as never);
      expect(result).toBe(150);
    });
  });

  describe('remove — soft-delete only (bugs.md B-009)', () => {
    it('flips status to INACTIVE instead of calling repo.delete', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findOne.mockResolvedValue(null);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ status: 'INACTIVE' }) as never);

      await service.remove('veh_1');

      expect(vehiclesRepo.update).toHaveBeenCalledWith({ id: 'veh_1' }, { status: 'INACTIVE' });
      expect(vehiclesRepo.delete).not.toHaveBeenCalled();
    });

    it('unassigns the current driver before deactivating the unit', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findOne.mockResolvedValue({ id: 'drv_1' } as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ status: 'INACTIVE' }) as never);

      await service.remove('veh_1');

      expect(driversRepo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { assignedVehicle: { disconnect: true } });
    });
  });
});
