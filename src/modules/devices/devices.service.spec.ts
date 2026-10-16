import { AppException } from '../../common/errors/app.exception';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';
import { CreateDeviceDto, DeviceListQueryDto, ImportDevicesDto } from './dto/devices.dto';

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
  let devicesRepo: jest.Mocked<Pick<DevicesRepository, 'findById' | 'findBySerial' | 'findByVehicleId' | 'create' | 'update' | 'delete' | 'list' | 'listAll' | 'connectionCounts'>>;
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
      connectionCounts: jest.fn().mockResolvedValue({ total: 0, connected: 0, offlineOver24h: 0 }),
    };
    vehiclesRepo = { findById: jest.fn() };
    service = new DevicesService(devicesRepo as unknown as DevicesRepository, vehiclesRepo as unknown as VehiclesRepository);
  });

  it('surfaces firmwareOutdated on read (TZ §5.4 — PT30 >= L108)', async () => {
    devicesRepo.findById.mockResolvedValue(makeDevice({ firmware: 'L107' }) as never);

    const view = await service.get('dev_1');

    expect(view.firmwareOutdated).toBe(true);
  });

  // pt30_pt40/tz.md §9.1 — V… serials belong to POST /mobile/virtual-devices only.
  it.each(['VPT30_A1B2', 'v123'])('create refuses the reserved serial %s with 422 VIRTUAL_SERIAL_RESERVED', async (serial) => {
    await expect(service.create(CreateDeviceDto.parse({ serial }))).rejects.toMatchObject({ code: 'VIRTUAL_SERIAL_RESERVED', status: 422 });
    expect(devicesRepo.create).not.toHaveBeenCalled();
  });

  it('import refuses the whole file when any row has a V… serial (nothing written)', async () => {
    const dto = ImportDevicesDto.parse({ devices: [{ serial: 'PT30_0001' }, { serial: 'VPT40_ZZZZ' }] });
    await expect(service.importMany(dto)).rejects.toMatchObject({
      code: 'VIRTUAL_SERIAL_RESERVED',
      details: { serials: [{ index: 1, serial: 'VPT40_ZZZZ' }] },
    });
    expect(devicesRepo.findBySerial).not.toHaveBeenCalled();
    expect(devicesRepo.create).not.toHaveBeenCalled();
  });

  it('list passes ?virtual through as isVirtual; export carries isVirtual', async () => {
    devicesRepo.list.mockResolvedValue({ items: [], total: 0 });
    await service.list(DeviceListQueryDto.parse({ virtual: 'true' }));
    expect(devicesRepo.list).toHaveBeenCalledWith(expect.objectContaining({ isVirtual: true }), 1, 25, { serial: 'asc' });
    devicesRepo.listAll.mockResolvedValue([makeDevice({ serial: 'VPT30_A1B2', isVirtual: true })] as never);
    expect((await service.exportAll())[0]).toMatchObject({ serial: 'VPT30_A1B2', isVirtual: true });
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

  describe('UI-012 — effective connection', () => {
    const NOW = new Date('2026-10-12T12:00:00Z');
    const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

    it.each([
      ['CONNECTED', minsAgo(5), 'CONNECTED'],
      ['CONNECTED', minsAgo(31), 'DISCONNECTED'],
      ['CONNECTED', null, 'DISCONNECTED'],
      ['OUT_OF_RANGE', minsAgo(1), 'DISCONNECTED'],
      ['DISCONNECTED', minsAgo(1), 'DISCONNECTED'],
    ] as const)('stored %s seen %s reads %s', async (bleState, lastSeenAt, expected) => {
      devicesRepo.list.mockResolvedValue({ items: [makeDevice({ bleState, lastSeenAt })], total: 1 } as never);
      const result = await service.list({ page: 1, limit: 25 }, NOW);
      expect(result.items[0].connection).toBe(expected);
      expect(result.items[0].bleState).toBe(bleState);
    });

    it('list carries inventory-wide connectionCounts (30 min / 24 h lines)', async () => {
      devicesRepo.list.mockResolvedValue({ items: [], total: 0 });
      devicesRepo.connectionCounts.mockResolvedValue({ total: 10, connected: 6, offlineOver24h: 2 });
      const result = await service.list({ page: 1, limit: 25, bleState: 'CONNECTED' } as never, NOW);
      expect(result.connectionCounts).toEqual({ total: 10, connected: 6, disconnected: 4, offlineOver24h: 2 });
      expect(devicesRepo.connectionCounts).toHaveBeenCalledWith(minsAgo(30), new Date('2026-10-11T12:00:00Z'));
    });
  });

  describe('create', () => {
    it('throws conflict when serial already registered', async () => {
      devicesRepo.findBySerial.mockResolvedValue(makeDevice() as never);
      await expect(service.create({ serial: 'PT30_A86E', model: 'PT30' } as never)).rejects.toThrow(AppException);
    });

    it('re-activates a RETIRED device with the same serial instead of refusing it', async () => {
      devicesRepo.findBySerial.mockResolvedValue(makeDevice({ status: 'RETIRED' }) as never);
      devicesRepo.update.mockResolvedValue(makeDevice({ model: 'PT40' }) as never);

      const view = await service.create(CreateDeviceDto.parse({ serial: 'pt30_a86e', model: 'PT40' }));

      expect(devicesRepo.create).not.toHaveBeenCalled();
      expect(devicesRepo.update).toHaveBeenCalledWith(
        { id: 'dev_1' },
        expect.objectContaining({ serial: 'PT30_A86E', status: 'UNASSIGNED', model: 'PT40', pairedAt: null }),
      );
      expect(view.status).toBe('UNASSIGNED');
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

    // CODE-009 — case/whitespace variants of a registered serial are the same device.
    it('normalises the serial (trim + upper) before the duplicate check and the write', async () => {
      devicesRepo.findBySerial.mockResolvedValue(null);
      devicesRepo.create.mockResolvedValue(makeDevice() as never);
      await service.create(CreateDeviceDto.parse({ serial: '  pt30_1c4f ' }));
      expect(devicesRepo.findBySerial).toHaveBeenCalledWith('PT30_1C4F');
      expect(devicesRepo.create).toHaveBeenCalledWith(expect.objectContaining({ serial: 'PT30_1C4F' }));
    });

    it('rejects a lower-case duplicate of a registered serial with 409', async () => {
      devicesRepo.findBySerial.mockResolvedValue(makeDevice({ serial: 'PT30_1C4F' }) as never);
      await expect(service.create(CreateDeviceDto.parse({ serial: 'pt30_1c4f' }))).rejects.toMatchObject({ status: 409 });
      expect(devicesRepo.create).not.toHaveBeenCalled();
    });

    it('import upserts a case variant onto the existing row instead of creating a duplicate', async () => {
      devicesRepo.findBySerial.mockResolvedValueOnce(makeDevice({ serial: 'PT30_1C4F' }) as never);
      devicesRepo.update.mockResolvedValue(makeDevice() as never);
      const summary = await service.importMany(ImportDevicesDto.parse({ devices: [{ serial: 'pt30_1c4f ' }] }));
      expect(devicesRepo.findBySerial).toHaveBeenCalledWith('PT30_1C4F');
      expect(summary).toMatchObject({ imported: 0, updated: 1 });
      expect(devicesRepo.create).not.toHaveBeenCalled();
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

    it('FE-12 — rejects pairing a RETIRED device with 409 DEVICE_RETIRED', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice({ status: 'RETIRED' }) as never);
      vehiclesRepo.findById.mockResolvedValue({ id: 'veh_1' } as never);
      devicesRepo.findByVehicleId.mockResolvedValue(null);
      await expect(service.pair('dev_1', { vehicleId: 'veh_1' })).rejects.toMatchObject({ code: 'DEVICE_RETIRED', status: 409 });
      expect(devicesRepo.update).not.toHaveBeenCalled();
    });

    it('BE-019 — rejects pairing to a soft-deleted unit', async () => {
      devicesRepo.findById.mockResolvedValue(makeDevice() as never);
      vehiclesRepo.findById.mockResolvedValue({ id: 'veh_1', deletedAt: new Date() } as never);
      await expect(service.pair('dev_1', { vehicleId: 'veh_1' })).rejects.toMatchObject({ code: 'VEHICLE_NOT_FOUND' });
      expect(devicesRepo.update).not.toHaveBeenCalled();
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

  it('diagnostics() 404s for an unknown device', async () => {
    devicesRepo.findById.mockResolvedValue(null);
    await expect(service.diagnostics('missing')).rejects.toBeInstanceOf(AppException);
  });

  it('diagnostics() derives responded:false (not an error) for a device that has never reported', async () => {
    devicesRepo.findById.mockResolvedValue(makeDevice({ bleState: 'DISCONNECTED', lastSeenAt: null }) as never);
    await expect(service.diagnostics('dev_1')).resolves.toEqual({ signalStrength: 'poor', gpsLock: false, responded: false });
  });

  it('create() persists autoFirmware/shareDiagnostics (B-88)', async () => {
    devicesRepo.findBySerial.mockResolvedValue(null);
    devicesRepo.create.mockResolvedValue(makeDevice() as never);

    await service.create({
      serial: 'PT30_A86E',
      model: 'PT30',
      periodicConnectedSec: 30,
      periodicDisconnectedMin: 30,
      autoFirmware: false,
      shareDiagnostics: false,
    } as never);

    expect(devicesRepo.create).toHaveBeenCalledWith(expect.objectContaining({ autoFirmware: false, shareDiagnostics: false }));
  });
});
