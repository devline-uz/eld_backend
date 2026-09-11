import { AppException } from '../../common/errors/app.exception';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';

function makeDevice(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'dev_1',
    serial: 'PT30_A86E',
    model: 'PT30',
    firmware: 'L113',
    status: 'UNASSIGNED',
    bleState: 'DISCONNECTED',
    vehicleId: null,
    ...overrides,
  };
}

describe('DevicesService', () => {
  let devicesRepo: jest.Mocked<Pick<DevicesRepository, 'findById' | 'findBySerial' | 'findByVehicleId' | 'create' | 'update' | 'delete' | 'list' | 'listAll'>>;
  let vehiclesRepo: jest.Mocked<Pick<VehiclesRepository, 'findById'>>;
  let service: DevicesService;

  beforeEach(() => {
    devicesRepo = {
      findById: jest.fn(),
      findBySerial: jest.fn(),
      findByVehicleId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
      listAll: jest.fn(),
    };
    vehiclesRepo = { findById: jest.fn() };
    service = new DevicesService(devicesRepo as unknown as DevicesRepository, vehiclesRepo as unknown as VehiclesRepository);
  });

  it('surfaces firmwareOutdated on read (TZ §5.4 — PT30 >= L108)', async () => {
    devicesRepo.findById.mockResolvedValue(makeDevice({ firmware: 'L107' }) as never);

    const view = await service.get('dev_1');

    expect(view.firmwareOutdated).toBe(true);
  });

  it('get throws DEVICE_NOT_FOUND when missing', async () => {
    devicesRepo.findById.mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toThrow(AppException);
  });

  it('list parses sort and maps items to views', async () => {
    devicesRepo.list.mockResolvedValue({ items: [makeDevice({ firmware: 'L107' })], total: 1 } as never);
    const result = await service.list({ page: 1, limit: 25 });
    expect(devicesRepo.list).toHaveBeenCalledWith({ status: undefined, bleState: undefined, q: undefined }, 1, 25, {
      serial: 'asc',
    });
    expect(result.items[0].firmwareOutdated).toBe(true);
  });

  describe('create', () => {
    it('throws conflict when serial already registered', async () => {
      devicesRepo.findBySerial.mockResolvedValue(makeDevice() as never);
      await expect(service.create({ serial: 'PT30_A86E', model: 'PT30' } as never)).rejects.toThrow(AppException);
    });

    it('creates when unique', async () => {
      devicesRepo.findBySerial.mockResolvedValue(null);
      devicesRepo.create.mockResolvedValue(makeDevice() as never);
      const view = await service.create({
        serial: 'PT30_NEW',
        model: 'PT30',
        bleMacAddress: 'AA:BB',
        firmware: 'L113',
        periodicConnectedSec: 60,
        periodicDisconnectedMin: 5,
      } as never);
      expect(view.id).toBe('dev_1');
    });
  });

  describe('update / updateFirmware / updateBleStatus / unpair', () => {
    it('update throws when device missing', async () => {
      devicesRepo.findById.mockResolvedValue(null);
      await expect(service.update('missing', {})).rejects.toThrow(AppException);
    });

    it('update builds a partial input from defined fields', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice() as never);
      devicesRepo.update.mockResolvedValue(makeDevice({ model: 'PT40' }) as never);
      await service.update('dev_1', { model: 'PT40', status: 'ACTIVE' } as never);
      expect(devicesRepo.update).toHaveBeenCalledWith({ id: 'dev_1' }, { model: 'PT40', status: 'ACTIVE' });
    });

    it('updateFirmware records the reported firmware version', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice() as never);
      devicesRepo.update.mockResolvedValue(makeDevice({ firmware: 'L120' }) as never);
      const view = await service.updateFirmware('dev_1', { firmware: 'L120' });
      expect(devicesRepo.update).toHaveBeenCalledWith({ id: 'dev_1' }, { firmware: 'L120' });
      expect(view.firmwareOutdated).toBe(false);
    });

    it('updateBleStatus records state + lastSeenAt, and storedEventsCount when given', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice() as never);
      devicesRepo.update.mockResolvedValue(makeDevice({ bleState: 'CONNECTED' }) as never);
      await service.updateBleStatus('dev_1', { bleState: 'CONNECTED', storedEventsCount: 3 } as never);
      expect(devicesRepo.update).toHaveBeenCalledWith(
        { id: 'dev_1' },
        expect.objectContaining({ bleState: 'CONNECTED', storedEventsCount: 3 }),
      );
    });

    it('updateBleStatus omits storedEventsCount when not given', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice() as never);
      devicesRepo.update.mockResolvedValue(makeDevice() as never);
      await service.updateBleStatus('dev_1', { bleState: 'DISCONNECTED' } as never);
      const data = devicesRepo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(data).not.toHaveProperty('storedEventsCount');
    });

    it('unpair disconnects the vehicle and resets status', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice({ vehicleId: 'veh_1' }) as never);
      devicesRepo.update.mockResolvedValue(makeDevice({ vehicleId: null, status: 'UNASSIGNED' }) as never);
      await service.unpair('dev_1');
      expect(devicesRepo.update).toHaveBeenCalledWith(
        { id: 'dev_1' },
        { vehicle: { disconnect: true }, status: 'UNASSIGNED', pairedAt: null },
      );
    });
  });

  describe('exportAll / importMany', () => {
    it('exportAll maps every device to a CreateDeviceDto shape', async () => {
      devicesRepo.listAll.mockResolvedValue([makeDevice({ bleMacAddress: null, firmware: null })] as never);
      const rows = await service.exportAll();
      expect(rows[0]).toEqual(expect.objectContaining({ serial: 'PT30_A86E', bleMacAddress: undefined }));
    });

    it('importMany creates new and updates existing rows, tolerating per-row failures', async () => {
      devicesRepo.findBySerial
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makeDevice() as never)
        .mockResolvedValueOnce(null);
      devicesRepo.create.mockResolvedValueOnce(makeDevice() as never).mockRejectedValueOnce(new Error('boom'));
      devicesRepo.update.mockResolvedValue(makeDevice() as never);

      const summary = await service.importMany({
        devices: [
          { serial: 'A', model: 'PT30' },
          { serial: 'B', model: 'PT30' },
          { serial: 'C', model: 'PT30' },
        ],
      } as never);

      expect(summary.imported).toBe(1);
      expect(summary.updated).toBe(1);
      expect(summary.failed).toEqual([{ index: 2, error: 'boom' }]);
    });
  });

  describe('pair — one device per unit (hard rule)', () => {
    it('pairs a device to an existing, unpaired vehicle', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice() as never);
      vehiclesRepo.findById.mockResolvedValue({ id: 'veh_1' } as never);
      devicesRepo.findByVehicleId.mockResolvedValue(null);
      devicesRepo.update.mockResolvedValue(makeDevice({ vehicleId: 'veh_1', status: 'ASSIGNED' }) as never);

      await service.pair('dev_1', { vehicleId: 'veh_1' });

      expect(devicesRepo.update).toHaveBeenCalledWith(
        { id: 'dev_1' },
        expect.objectContaining({ vehicle: { connect: { id: 'veh_1' } }, status: 'ASSIGNED' }),
      );
    });

    it('rejects pairing when the unit already has a different device', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice() as never);
      vehiclesRepo.findById.mockResolvedValue({ id: 'veh_1' } as never);
      devicesRepo.findByVehicleId.mockResolvedValue(makeDevice({ id: 'dev_2' }) as never);

      await expect(service.pair('dev_1', { vehicleId: 'veh_1' })).rejects.toThrow(AppException);
      expect(devicesRepo.update).not.toHaveBeenCalled();
    });

    it('rejects pairing to a vehicle that does not exist', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice() as never);
      vehiclesRepo.findById.mockResolvedValue(null);

      await expect(service.pair('dev_1', { vehicleId: 'veh_missing' })).rejects.toThrow(AppException);
    });
  });

  it('remove() retires and unpairs instead of hard-deleting (bugs.md B-009)', async () => {
    devicesRepo.findById.mockResolvedValue(makeDevice({ vehicleId: 'veh_1' }) as never);
    devicesRepo.update.mockResolvedValue(makeDevice({ status: 'RETIRED', vehicleId: null }) as never);

    await service.remove('dev_1');

    expect(devicesRepo.update).toHaveBeenCalledWith(
      { id: 'dev_1' },
      { status: 'RETIRED', vehicle: { disconnect: true }, pairedAt: null },
    );
    expect(devicesRepo.delete).not.toHaveBeenCalled();
  });
});
