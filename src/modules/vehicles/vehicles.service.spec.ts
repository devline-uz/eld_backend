import { UpdateVehicleDto } from './dto/vehicles.dto';
import { AppException } from '../../common/errors/app.exception';
import type { PushService } from '../../core/firebase/push.service';
import type { CarrierRepository } from '../carrier/carrier.repository';
import { DriversRepository } from '../drivers/drivers.repository';
import type { NotificationsRepository } from '../notifications/notifications.repository';
import type { TransactionalMailPort } from '../../core/mail/mail.port';
import type { UsersRepository } from '../users/users.repository';
import { EldSerialTakenError, VehiclesRepository } from './vehicles.repository';
import { VehiclesService } from './vehicles.service';

const UNIT_TAKEN = {
  code: 'UNIT_NUMBER_TAKEN',
  status: 409,
  message: 'A unit with this number already exists.',
  details: { unitNumber: 'A unit with this number already exists.' },
};
const VIN_TAKEN = {
  code: 'VIN_TAKEN',
  status: 409,
  message: 'A unit with this VIN already exists.',
  details: { vin: 'A unit with this VIN already exists.' },
};

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
  let vehiclesRepo: jest.Mocked<
    Pick<
      VehiclesRepository,
      | 'findById'
      | 'update'
      | 'findByUnitNumber'
      | 'findByVin'
      | 'list'
      | 'listAll'
      | 'create'
      | 'delete'
      | 'findOpenCriticalDefectIds'
      | 'findAuditRows'
      | 'findDvirRows'
      | 'findDeviceBySerial'
      | 'pairDevice'
      | 'findTelemetryRange'
      | 'findTelemetryRecent'
      | 'groupExists'
      | 'findDeviceForPairing'
      | 'findDeviceByVehicleId'
      | 'findLiveByPlate'
      | 'saveWithDevice'
      | 'releaseDevice'
      | 'findOpenTrips'
      | 'countByStatus'
    >
  >;
  let driversRepo: jest.Mocked<Pick<DriversRepository, 'findById' | 'update' | 'findOne'>>;
  let notifications: jest.Mocked<Pick<NotificationsRepository, 'create'>>;
  let carrier: jest.Mocked<Pick<CarrierRepository, 'get'>>;
  let users: jest.Mocked<Pick<UsersRepository, 'findById'>>;
  let mail: jest.Mocked<TransactionalMailPort>;
  let push: jest.Mocked<Pick<PushService, 'sendToDriver'>>;
  let events: { publish: jest.Mock<Promise<void>, [string, { room: string; event: string; payload: unknown }]> };
  let service: VehiclesService;

  beforeEach(() => {
    vehiclesRepo = {
      findById: jest.fn(),
      update: jest.fn(),
      findByUnitNumber: jest.fn(),
      findByVin: jest.fn(),
      list: jest.fn(),
      countByStatus: jest.fn().mockResolvedValue({ ACTIVE: 0, INACTIVE: 0, OUT_OF_SERVICE: 0, total: 0 }),
      listAll: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      findOpenCriticalDefectIds: jest.fn().mockResolvedValue([]),
      findAuditRows: jest.fn().mockResolvedValue([]),
      findDvirRows: jest.fn().mockResolvedValue([]),
      findDeviceBySerial: jest.fn(),
      pairDevice: jest.fn(),
      groupExists: jest.fn().mockResolvedValue(true),
      findTelemetryRange: jest.fn().mockResolvedValue([]),
      findTelemetryRecent: jest.fn().mockResolvedValue([]),
      findDeviceForPairing: jest.fn().mockResolvedValue(null),
      findDeviceByVehicleId: jest.fn().mockResolvedValue(null),
      findLiveByPlate: jest.fn().mockResolvedValue(null),
      saveWithDevice: jest.fn(),
      releaseDevice: jest.fn().mockResolvedValue({ count: 0 }),
      findOpenTrips: jest.fn().mockResolvedValue([]),
    };
    driversRepo = {
      findById: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
    };
    notifications = { create: jest.fn().mockResolvedValue({ id: 'ntf_0' }) };
    carrier = { get: jest.fn().mockResolvedValue({ timezone: 'America/New_York' }) };
    users = { findById: jest.fn() };
    mail = { send: jest.fn().mockResolvedValue({ delivered: false, reference: 'NO_MAIL_TRANSPORT' }) };
    push = { sendToDriver: jest.fn().mockResolvedValue(undefined) };
    events = { publish: jest.fn<Promise<void>, [string, { room: string; event: string; payload: unknown }]>().mockResolvedValue(undefined) };
    service = new VehiclesService(
      vehiclesRepo as unknown as VehiclesRepository,
      driversRepo as unknown as DriversRepository,
      notifications as unknown as NotificationsRepository,
      carrier as unknown as CarrierRepository,
      users as unknown as UsersRepository,
      push as unknown as PushService,
      mail,
      events as never,
    );
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

      await expect(service.assignDriver('veh_1', { driverId: 'drv_1', notify: true })).rejects.toThrow(AppException);
      expect(driversRepo.update).not.toHaveBeenCalled();
    });

    it('assigns the driver when the vehicle is ACTIVE', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });

      expect(driversRepo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { assignedVehicle: { connect: { id: 'veh_1' } } });
    });

    it('surfaces a conflict when the unit is already assigned to another driver', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      driversRepo.update.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

      await expect(service.assignDriver('veh_1', { driverId: 'drv_1', notify: true })).rejects.toMatchObject({ status: 409 });
    });

    it('BE-006 — any other write error is NOT masked as a 409', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      const boom = Object.assign(new Error('db down'), { code: 'P1001' });
      driversRepo.update.mockRejectedValue(boom);

      await expect(service.assignDriver('veh_1', { driverId: 'drv_1', notify: true })).rejects.toBe(boom);
    });

    it('BE-006 — a soft-deleted driver is 404, a TERMINATED / INACTIVE one 409, an INACTIVE unit 409', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValueOnce({ id: 'drv_1', status: 'TERMINATED', deletedAt: new Date(), assignedVehicleId: null } as never);
      await expect(service.assignDriver('veh_1', { driverId: 'drv_1', notify: true })).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND', status: 404 });
      driversRepo.findById.mockResolvedValueOnce({ id: 'drv_1', status: 'TERMINATED', deletedAt: null, assignedVehicleId: null } as never);
      await expect(service.assignDriver('veh_1', { driverId: 'drv_1', notify: true })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      driversRepo.findById.mockResolvedValueOnce({ id: 'drv_1', status: 'INACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      await expect(service.assignDriver('veh_1', { driverId: 'drv_1', notify: true })).rejects.toMatchObject({ status: 409 });
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'INACTIVE' }) as never);
      await expect(service.assignDriver('veh_1', { driverId: 'drv_1', notify: true })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
      expect(driversRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('remove — open trips (BE-013)', () => {
    it('is a 409 listing the open trips and changes nothing', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findOpenTrips.mockResolvedValue([{ id: 'trp_1', number: 'TRP-1', status: 'PLANNED' }]);
      await expect(service.remove('veh_1')).rejects.toMatchObject({
        code: 'CONFLICT',
        status: 409,
        details: { openTrips: [{ id: 'trp_1', number: 'TRP-1', status: 'PLANNED' }] },
      });
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
      expect(driversRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('assignDriver — B-74 notify', () => {
    it('creates a notification when notify is true', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });

      expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('never creates a notification when notify is false', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: false });

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('pushes FCM via PushService with the persisted deep-link fields (§12.7)', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);
      notifications.create.mockResolvedValue({ id: 'ntf_1', objectType: 'Vehicle', objectId: 'veh_1', category: 'assignment' } as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });

      expect(push.sendToDriver).toHaveBeenCalledWith(
        'drv_1',
        expect.objectContaining({ title: 'New unit assignment' }),
        { type: 'ASSIGNMENT', id: 'ntf_1', driverId: 'drv_1', objectType: 'Vehicle', objectId: 'veh_1', category: 'assignment' },
      );
    });

    it('does not push when notify is false', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: false });

      expect(push.sendToDriver).not.toHaveBeenCalled();
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

    it('UI-004 — list carries fleet-wide statusCounts, whatever the status filter', async () => {
      vehiclesRepo.list.mockResolvedValue({ items: [], total: 0 });
      vehiclesRepo.countByStatus.mockResolvedValue({ ACTIVE: 5, INACTIVE: 2, OUT_OF_SERVICE: 1, total: 8 });
      const result = await service.list({ page: 1, limit: 20, status: 'OUT_OF_SERVICE' } as never);
      expect(result.statusCounts).toEqual({ ACTIVE: 5, INACTIVE: 2, OUT_OF_SERVICE: 1, total: 8 });
      expect(vehiclesRepo.countByStatus).toHaveBeenCalledWith();
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
      await expect(service.create({ unitNumber: '#101', vin: 'VIN' } as never)).rejects.toMatchObject(UNIT_TAKEN);
    });

    it('throws conflict when VIN already exists', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(makeVehicle() as never);
      await expect(service.create({ unitNumber: '#101', vin: 'VIN' } as never)).rejects.toMatchObject(VIN_TAKEN);
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

    it('connects `groupId` and rejects an unknown one with VEHICLE_GROUP_NOT_FOUND', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle() as never);
      await service.create({ unitNumber: '#101', vin: 'VIN', groupId: 'vg_1' } as never);
      expect(vehiclesRepo.create).toHaveBeenCalledWith(expect.objectContaining({ group: { connect: { id: 'vg_1' } } }));

      vehiclesRepo.groupExists.mockResolvedValue(false);
      await expect(service.create({ unitNumber: '#102', vin: 'VIN2', groupId: 'vg_x' } as never)).rejects.toMatchObject({
        code: 'VEHICLE_GROUP_NOT_FOUND',
      });
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

    it('`groupId: null` removes the unit from its group', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle() as never);
      await service.update('veh_1', { groupId: null });
      expect(vehiclesRepo.update).toHaveBeenCalledWith({ id: 'veh_1' }, { group: { disconnect: true } });
    });

    // CODE-010 — the edit form sends `null` for a field the user emptied; it must be cleared.
    it('`null` clears the plate, issuing state and notes', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ licensePlate: 'ABC123', plateState: 'OH', notes: 'x' }) as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle() as never);
      await service.update('veh_1', UpdateVehicleDto.parse({ licensePlate: null, plateState: null, notes: null }));
      expect(vehiclesRepo.update).toHaveBeenCalledWith({ id: 'veh_1' }, { licensePlate: null, plateState: null, notes: null });
    });
  });

  describe('soft delete frees unitNumber / VIN (partial unique indexes on live rows)', () => {
    const p2002 = (target: string[] | string) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });

    it('re-creating a unit with a soft-deleted unit\'s unitNumber and VIN succeeds', async () => {
      // The live-only lookups don't see the deleted row, so nothing collides.
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle({ id: 'veh_new' }) as never);
      const result = await service.create({ unitNumber: '#101', vin: '1FUJA6CV88LW12345' } as never);
      expect(result.id).toBe('veh_new');
      expect(vehiclesRepo.findByUnitNumber).toHaveBeenCalledWith('#101');
      expect(vehiclesRepo.findByVin).toHaveBeenCalledWith('1FUJA6CV88LW12345');
      expect(vehiclesRepo.create).toHaveBeenCalledWith(expect.objectContaining({ unitNumber: '#101', vin: '1FUJA6CV88LW12345' }));
    });

    it('a duplicate among live units is still a 409', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      await expect(service.create({ unitNumber: '#101', vin: 'OTHER' } as never)).rejects.toMatchObject(UNIT_TAKEN);
      expect(vehiclesRepo.create).not.toHaveBeenCalled();
    });

    it('maps a racing P2002 on create to a field-level 409 naming the column', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockRejectedValue(p2002(['vin']));
      await expect(service.create({ unitNumber: '#101', vin: 'VIN9' } as never)).rejects.toMatchObject(VIN_TAKEN);
    });

    it.each([
      ['Vehicle_vin_live_key', VIN_TAKEN],
      ['Vehicle_vin_key', VIN_TAKEN],
      ['Vehicle_unitNumber_live_key', UNIT_TAKEN],
      [['unitNumber'], UNIT_TAKEN],
    ])('maps P2002 target %j to the matching field', async (target, expected) => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockRejectedValue(p2002(target));
      await expect(service.create({ unitNumber: '#101', vin: 'VIN9' } as never)).rejects.toMatchObject(expected);
    });

    it('an unattributable P2002 stays a generic 409 CONFLICT', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockRejectedValue(p2002(['somethingElse']));
      await expect(service.create({ unitNumber: '#101', vin: 'VIN9' } as never)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    });

    it('importMany reports the field-level message for a row whose VIN races into the index', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockRejectedValue(p2002('Vehicle_vin_live_key'));
      const summary = await service.importMany({ vehicles: [{ unitNumber: '#101', vin: '1FUJA6CV88LW12345' }] } as never);
      expect(summary.failed).toEqual([{ index: 0, error: 'A unit with this VIN already exists.' }]);
    });

    it('rethrows non-P2002 errors from create untouched', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      const boom = new Error('db down');
      vehiclesRepo.create.mockRejectedValue(boom);
      await expect(service.create({ unitNumber: '#101', vin: 'VIN9' } as never)).rejects.toBe(boom);
    });

    it('update rejects a unitNumber held by another live unit', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findByUnitNumber.mockResolvedValue(makeVehicle({ id: 'veh_2', unitNumber: '#202' }) as never);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      await expect(service.update('veh_1', { unitNumber: '#202' })).rejects.toMatchObject(UNIT_TAKEN);
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
    });

    it('update rejects a VIN held by another live unit', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(makeVehicle({ id: 'veh_2' }) as never);
      await expect(service.update('veh_1', { vin: 'TAKEN' })).rejects.toMatchObject(VIN_TAKEN);
    });

    it('update lets a unit re-send its own unitNumber / VIN', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findByUnitNumber.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findByVin.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle() as never);
      await service.update('veh_1', { unitNumber: '#101', vin: '1FUJA6CV88LW12345' });
      expect(vehiclesRepo.update).toHaveBeenCalled();
    });

    it('update maps a racing P2002 to a 409', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.update.mockRejectedValue(p2002(['unitNumber']));
      await expect(service.update('veh_1', { unitNumber: '#303' })).rejects.toMatchObject(UNIT_TAKEN);
    });

    it('get treats a soft-deleted unit as not found', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ deletedAt: new Date() }) as never);
      await expect(service.get('veh_1')).rejects.toMatchObject({ code: 'VEHICLE_NOT_FOUND' });
    });

    it('importMany creates a new unit when only a soft-deleted unit had its unitNumber/VIN', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle({ id: 'veh_new' }) as never);
      const summary = await service.importMany({ vehicles: [{ unitNumber: '#101', vin: '1FUJA6CV88LW12345' }] } as never);
      expect(summary).toMatchObject({ imported: 1, updated: 0, failed: [] });
    });
  });

  describe('ELD serial and plate + state uniqueness (live units)', () => {
    const p2002 = (target: string[] | string) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });
    const device = (overrides: Partial<Record<string, unknown>> = {}) => ({
      id: 'dev_1',
      serial: 'PT30_1C4F',
      vehicleId: null,
      vehicle: null,
      ...overrides,
    });
    const SERIAL_TAKEN = {
      code: 'ELD_SERIAL_TAKEN',
      status: 409,
      message: 'This ELD serial is already assigned to another unit.',
      details: { eldSerial: 'This ELD serial is already assigned to another unit.' },
    };
    const PLATE_TAKEN = {
      code: 'LICENSE_PLATE_TAKEN',
      status: 409,
      message: 'This license plate is already registered for this state.',
      details: { licensePlate: 'This license plate is already registered for this state.' },
    };
    const base = { unitNumber: '#900', vin: '1FUJA6CV88LW90000' };

    beforeEach(() => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle({ id: 'veh_new' }) as never);
      vehiclesRepo.saveWithDevice.mockResolvedValue(makeVehicle({ id: 'veh_new' }) as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle() as never);
    });

    it('(a) pairs a free device on create inside the transactional write', async () => {
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(device() as never);
      await service.create({ ...base, deviceId: 'PT30_1C4F' } as never);
      expect(vehiclesRepo.findDeviceForPairing).toHaveBeenCalledWith('PT30_1C4F');
      expect(vehiclesRepo.saveWithDevice).toHaveBeenCalledWith(
        { create: expect.objectContaining({ unitNumber: '#900' }) as unknown },
        'dev_1',
      );
      expect(vehiclesRepo.create).not.toHaveBeenCalled();
    });

    it('accepts `eldSerial` as an alias of `deviceId`', async () => {
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(device() as never);
      await service.create({ ...base, eldSerial: 'pt30_1c4f' } as never);
      expect(vehiclesRepo.findDeviceForPairing).toHaveBeenCalledWith('PT30_1C4F');
    });

    it('an empty serial / plate never conflicts and pairs nothing', async () => {
      await service.create({ ...base, deviceId: '   ', licensePlate: '', plateState: 'OH' } as never);
      expect(vehiclesRepo.findDeviceForPairing).not.toHaveBeenCalled();
      expect(vehiclesRepo.findLiveByPlate).not.toHaveBeenCalled();
      expect(vehiclesRepo.create).toHaveBeenCalledWith(expect.objectContaining({ licensePlate: null, plateState: 'OH' }));
    });

    it('(b) rejects a serial already paired to another live unit with ELD_SERIAL_TAKEN', async () => {
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(
        device({ vehicleId: 'veh_2', vehicle: { id: 'veh_2', deletedAt: null } }) as never,
      );
      await expect(service.create({ ...base, deviceId: 'PT30_1C4F' } as never)).rejects.toMatchObject(SERIAL_TAKEN);
      expect(vehiclesRepo.create).not.toHaveBeenCalled();
      expect(vehiclesRepo.saveWithDevice).not.toHaveBeenCalled();
    });

    it('a device left on a soft-deleted unit is free to pair', async () => {
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(
        device({ vehicleId: 'veh_old', vehicle: { id: 'veh_old', deletedAt: new Date() } }) as never,
      );
      await service.create({ ...base, deviceId: 'PT30_1C4F' } as never);
      expect(vehiclesRepo.saveWithDevice).toHaveBeenCalledWith(expect.anything(), 'dev_1');
    });

    it('an unknown serial is a 404 DEVICE_NOT_FOUND naming the field', async () => {
      await expect(service.create({ ...base, deviceId: 'NOPE' } as never)).rejects.toMatchObject({
        code: 'DEVICE_NOT_FOUND',
        status: 404,
        details: { eldSerial: 'No ELD device with this serial is registered.' },
      });
    });

    it('(c) allows the same plate in a different state', async () => {
      await service.create({ ...base, licensePlate: 'ABC123', plateState: 'TX' } as never);
      expect(vehiclesRepo.findLiveByPlate).toHaveBeenCalledWith('ABC123', 'TX', undefined);
      expect(vehiclesRepo.create).toHaveBeenCalled();
    });

    it('(d) rejects the same plate in the same state with LICENSE_PLATE_TAKEN', async () => {
      vehiclesRepo.findLiveByPlate.mockResolvedValue(makeVehicle({ id: 'veh_2' }) as never);
      await expect(service.create({ ...base, licensePlate: 'ABC123', plateState: 'OH' } as never)).rejects.toMatchObject(PLATE_TAKEN);
      expect(vehiclesRepo.create).not.toHaveBeenCalled();
    });

    it('(h) normalises casing / whitespace before the checks and the write', async () => {
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(device() as never);
      await service.create({ ...base, deviceId: '  pt30_1c4f ', licensePlate: ' abc123 ', plateState: ' oh' } as never);
      expect(vehiclesRepo.findDeviceForPairing).toHaveBeenCalledWith('PT30_1C4F');
      expect(vehiclesRepo.findLiveByPlate).toHaveBeenCalledWith('ABC123', 'OH', undefined);
      expect(vehiclesRepo.saveWithDevice).toHaveBeenCalledWith(
        { create: expect.objectContaining({ licensePlate: 'ABC123', plateState: 'OH' }) as unknown },
        'dev_1',
      );
    });

    it('(h) a casing variant of a taken plate is still taken', async () => {
      vehiclesRepo.findLiveByPlate.mockImplementation((plate, state) =>
        Promise.resolve((plate === 'ABC123' && state === 'OH' ? makeVehicle({ id: 'veh_2' }) : null) as never),
      );
      await expect(service.create({ ...base, licensePlate: 'abc123 ', plateState: 'Oh' } as never)).rejects.toMatchObject(PLATE_TAKEN);
    });

    it('(e) edit re-sending its own serial and plate is allowed and does not re-pair', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ licensePlate: 'ABC123', plateState: 'OH' }) as never);
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(
        device({ vehicleId: 'veh_1', vehicle: { id: 'veh_1', deletedAt: null } }) as never,
      );
      await service.update('veh_1', { deviceId: 'pt30_1c4f', licensePlate: 'abc123', plateState: 'oh', make: 'Volvo' });
      expect(vehiclesRepo.findLiveByPlate).not.toHaveBeenCalled();
      expect(vehiclesRepo.saveWithDevice).not.toHaveBeenCalled();
      expect(vehiclesRepo.update).toHaveBeenCalledWith(
        { id: 'veh_1' },
        { make: 'Volvo', licensePlate: 'ABC123', plateState: 'OH' },
      );
    });

    it('(f) edit using another live unit\'s serial is rejected', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(
        device({ vehicleId: 'veh_2', vehicle: { id: 'veh_2', deletedAt: null } }) as never,
      );
      await expect(service.update('veh_1', { deviceId: 'PT30_1C4F' })).rejects.toMatchObject(SERIAL_TAKEN);
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
      expect(vehiclesRepo.saveWithDevice).not.toHaveBeenCalled();
    });

    it('edit switching to a free device pairs it in the transactional write', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(device({ id: 'dev_9' }) as never);
      vehiclesRepo.saveWithDevice.mockResolvedValue(makeVehicle() as never);
      await service.update('veh_1', { deviceId: 'PT30_9999' });
      expect(vehiclesRepo.saveWithDevice).toHaveBeenCalledWith({ id: 'veh_1', update: {} }, 'dev_9');
    });

    it('edit clearing the serial unpairs the current device', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findDeviceByVehicleId.mockResolvedValue({ id: 'dev_1' } as never);
      vehiclesRepo.saveWithDevice.mockResolvedValue(makeVehicle() as never);
      await service.update('veh_1', { deviceId: null });
      expect(vehiclesRepo.saveWithDevice).toHaveBeenCalledWith({ id: 'veh_1', update: {} }, null);
    });

    it('(g) edit using another live unit\'s plate + state is rejected', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ licensePlate: 'XYZ1', plateState: 'OH' }) as never);
      vehiclesRepo.findLiveByPlate.mockResolvedValue(makeVehicle({ id: 'veh_2' }) as never);
      await expect(service.update('veh_1', { licensePlate: ' abc123' })).rejects.toMatchObject(PLATE_TAKEN);
      // A partial PATCH is judged on the pair the unit ends up with (stored state kept).
      expect(vehiclesRepo.findLiveByPlate).toHaveBeenCalledWith('ABC123', 'OH', 'veh_1');
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
    });

    it('maps a racing P2002 on the plate index to LICENSE_PLATE_TAKEN', async () => {
      vehiclesRepo.create.mockRejectedValue(p2002('Vehicle_plate_state_live_key'));
      await expect(service.create({ ...base, licensePlate: 'ABC123', plateState: 'OH' } as never)).rejects.toMatchObject(PLATE_TAKEN);
    });

    it('maps a racing P2002 on the device pairing to ELD_SERIAL_TAKEN', async () => {
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(device() as never);
      vehiclesRepo.saveWithDevice.mockRejectedValue(p2002(['vehicleId']));
      await expect(service.create({ ...base, deviceId: 'PT30_1C4F' } as never)).rejects.toMatchObject(SERIAL_TAKEN);
    });

    it('maps a lost conditional device claim (EldSerialTakenError) to ELD_SERIAL_TAKEN', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findDeviceForPairing.mockResolvedValue(device() as never);
      vehiclesRepo.saveWithDevice.mockRejectedValue(new EldSerialTakenError());
      await expect(service.update('veh_1', { deviceId: 'PT30_1C4F' })).rejects.toMatchObject(SERIAL_TAKEN);
    });

    it('soft delete releases the unit\'s ELD device', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ status: 'INACTIVE' }) as never);
      await service.remove('veh_1');
      expect(vehiclesRepo.releaseDevice).toHaveBeenCalledWith('veh_1');
    });
  });

  describe('update — VEHICLE_HAS_OPEN_CRITICAL_DEFECTS hard rule (bugs.md: unit 101 regression)', () => {
    it('blocks PATCH to ACTIVE while an open critical defect exists', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);
      vehiclesRepo.findOpenCriticalDefectIds.mockResolvedValue([{ id: 'def_1' }] as never);

      await expect(service.update('veh_1', { status: 'ACTIVE' } as never)).rejects.toThrow(AppException);
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
    });

    it('blocks PATCH to INACTIVE while an open critical defect exists', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);
      vehiclesRepo.findOpenCriticalDefectIds.mockResolvedValue([{ id: 'def_1' }] as never);

      await expect(service.update('veh_1', { status: 'INACTIVE' } as never)).rejects.toThrow(AppException);
    });

    it('allows PATCH to ACTIVE when defects are resolved or non-critical', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);
      vehiclesRepo.findOpenCriticalDefectIds.mockResolvedValue([]);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ status: 'ACTIVE' }) as never);

      await service.update('veh_1', { status: 'ACTIVE' } as never);

      expect(vehiclesRepo.update).toHaveBeenCalledWith({ id: 'veh_1' }, { status: 'ACTIVE' });
    });

    it('allows PATCH to OUT_OF_SERVICE regardless of open defects (never itself blocked)', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'ACTIVE' }) as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);

      await service.update('veh_1', { status: 'OUT_OF_SERVICE' } as never);

      expect(vehiclesRepo.findOpenCriticalDefectIds).not.toHaveBeenCalled();
      expect(vehiclesRepo.update).toHaveBeenCalledWith({ id: 'veh_1' }, { status: 'OUT_OF_SERVICE' });
    });

    it('allows non-status edits without checking defects', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ make: 'Volvo' }) as never);

      await service.update('veh_1', { make: 'Volvo' });

      expect(vehiclesRepo.findOpenCriticalDefectIds).not.toHaveBeenCalled();
      expect(vehiclesRepo.update).toHaveBeenCalled();
    });
  });

  describe('realtime on assignment (B-0xx)', () => {
    const published = () => events.publish.mock.calls.map((c) => [c[0], c[1].room, c[1].event, c[1].payload]);

    it('assignDriver pushes vehicle.assigned, bootstrap.changed and notification.new to driver:{id}', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);
      const row = { id: 'ntf_1', objectType: 'Vehicle', objectId: 'veh_1', category: 'assignment' };
      notifications.create.mockResolvedValue(row as never);
      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });
      const sent = published();
      expect(sent.map((x) => x[2])).toEqual(['vehicle.assigned', 'bootstrap.changed', 'notification.new']);
      expect(sent[0]).toEqual(['realtime.push', 'driver:drv_1', 'vehicle.assigned', expect.objectContaining({ driverId: 'drv_1', vehicleId: 'veh_1' })]);
      expect(sent[1][3]).toEqual({ reason: 'vehicle_assigned' });
      expect(sent[2][3]).toEqual({ notification: row });
    });

    it('assignDriver with notify=false still refreshes the app but sends no notification.new', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);
      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: false });
      expect(published().map((x) => x[2])).toEqual(['vehicle.assigned', 'bootstrap.changed']);
    });

    it('unassignDriver pushes vehicle.unassigned + bootstrap.changed and notifies in-app + FCM', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ unitNumber: '103' }) as never);
      driversRepo.findOne.mockResolvedValue({ id: 'drv_1' } as never);
      driversRepo.update.mockResolvedValue({} as never);
      notifications.create.mockResolvedValue({ id: 'ntf_2', objectType: 'Vehicle', objectId: 'veh_1', category: 'assignment' } as never);
      await service.unassignDriver('veh_1');
      expect(published().map((x) => [x[1], x[2]])).toEqual([
        ['driver:drv_1', 'vehicle.unassigned'],
        ['driver:drv_1', 'bootstrap.changed'],
        ['driver:drv_1', 'notification.new'],
      ]);
      expect(published()[0][3]).toEqual({ driverId: 'drv_1', vehicleId: 'veh_1' });
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ driverId: 'drv_1', type: 'ASSIGNMENT', body: "You've been unassigned from unit 103.", category: 'assignment' }),
      );
      expect(push.sendToDriver).toHaveBeenCalledTimes(1);
    });

    it('unassignDriver with notify=false sends no notification or FCM', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findOne.mockResolvedValue({ id: 'drv_1' } as never);
      driversRepo.update.mockResolvedValue({} as never);
      await service.unassignDriver('veh_1', { notify: false });
      expect(notifications.create).not.toHaveBeenCalled();
      expect(push.sendToDriver).not.toHaveBeenCalled();
      expect(published().map((x) => x[2])).toEqual(['vehicle.unassigned', 'bootstrap.changed']);
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
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', status: 'ACTIVE', deletedAt: null, assignedVehicleId: 'veh_1' } as never);
      const result = await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });
      expect(driversRepo.update).not.toHaveBeenCalled();
      expect(result.id).toBe('veh_1');
    });

    it('throws DRIVER_NOT_FOUND when driver does not exist', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue(null);
      await expect(service.assignDriver('veh_1', { driverId: 'missing', notify: true })).rejects.toThrow(AppException);
    });
  });

  describe('bulkUpdateStatus (B-71)', () => {
    it('updates each id independently and reports per-row failures', async () => {
      vehiclesRepo.findById.mockResolvedValueOnce(makeVehicle({ id: 'veh_1' }) as never).mockResolvedValueOnce(null);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ status: 'INACTIVE' }) as never);

      const result = await service.bulkUpdateStatus({ ids: ['veh_1', 'veh_missing'], status: 'INACTIVE' });

      expect(result.updated).toEqual(['veh_1']);
      expect(result.failed).toEqual([{ id: 'veh_missing', error: 'Vehicle not found.' }]);
    });
  });

  describe('activities (B-5)', () => {
    it('merges audit rows and DVIR rows, newest first', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findAuditRows.mockResolvedValue([
        { id: 1n, actorId: 'usr_1', actorType: 'USER', action: 'UPDATE', detail: null, before: null, after: { status: 'ACTIVE' }, createdAt: new Date('2026-09-24T10:00:00.000Z') },
      ] as never);
      vehiclesRepo.findDvirRows.mockResolvedValue([
        { id: 'dvir_1', type: 'PRE_TRIP', submittedAt: new Date('2026-09-24T12:00:00.000Z'), vehicleCondition: 'SATISFACTORY', notes: null, driver: { firstName: 'John', lastName: 'Smith' } },
      ] as never);

      const items = await service.activities('veh_1');

      expect(items).toHaveLength(2);
      expect(items[0].id).toBe('dvir_dvir_1'); // newer DVIR row first
      expect(items[1].id).toBe('audit_1');
    });
  });

  describe('histories (B-4)', () => {
    it('returns zeroed KPIs for a day with no telemetry', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findOne.mockResolvedValue(null);
      vehiclesRepo.findTelemetryRange.mockResolvedValue([]);

      const result = await service.histories('veh_1', '2026-09-24');

      expect(result.date).toBe('2026-09-24');
      expect(result.distanceMi).toBe(0);
      expect(result.segments).toEqual([]);
    });

    it('falls back to the carrier timezone when no driver is assigned', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findOne.mockResolvedValue(null);
      vehiclesRepo.findTelemetryRange.mockResolvedValue([]);

      await service.histories('veh_1', '2026-09-24');

      expect(carrier.get).toHaveBeenCalled();
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

    it('importMany reports a per-row failure instead of reactivating a unit with open critical defects', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);
      vehiclesRepo.findOpenCriticalDefectIds.mockResolvedValue([{ id: 'def_1' }] as never);

      const summary = await service.importMany({
        vehicles: [{ unitNumber: '#101', vin: 'VIN-A', status: 'ACTIVE', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0 } as never],
      });

      expect(summary.updated).toBe(0);
      expect(summary.failed).toHaveLength(1);
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
    });

    it('B-69 duplicateStrategy SKIP leaves an existing row untouched', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(makeVehicle() as never);

      const summary = await service.importMany({
        vehicles: [{ unitNumber: '#101', vin: 'VIN-A', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0 }],
        options: { duplicateStrategy: 'SKIP', pairDevices: false, emailSummary: false },
      });

      expect(summary).toEqual({ imported: 0, updated: 0, skipped: 1, failed: [] });
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
    });

    it('B-69 pairDevices pairs a row deviceSerial to the created unit', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle() as never);
      vehiclesRepo.findDeviceBySerial.mockResolvedValue({ id: 'dev_1', vehicleId: null } as never);

      await service.importMany({
        vehicles: [{ unitNumber: '#101', vin: 'VIN-A', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0, deviceSerial: 'PT30_A1' }],
        options: { duplicateStrategy: 'UPDATE_BY_VIN', pairDevices: true, emailSummary: false },
      });

      expect(vehiclesRepo.pairDevice).toHaveBeenCalledWith('dev_1', 'veh_1');
    });

    it('B-69 emailSummary emails the calling user when true', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle() as never);
      users.findById.mockResolvedValue({ email: 'dispatch@example.com' } as never);

      await service.importMany(
        { vehicles: [{ unitNumber: '#101', vin: 'VIN-A', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0 }], options: { duplicateStrategy: 'UPDATE_BY_VIN', pairDevices: false, emailSummary: true } },
        'usr_1',
      );

      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(mail.send).toHaveBeenCalledWith({
        to: 'dispatch@example.com',
        subject: 'Vehicle import summary',
        text: 'Imported 1, updated 0, skipped 0, failed 0.',
      });
    });

    it('B-69 emailSummary — an undelivered summary (SMTP failure) never fails the import', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle() as never);
      users.findById.mockResolvedValue({ email: 'dispatch@example.com' } as never);
      mail.send.mockResolvedValue({ delivered: false, reference: 'SMTP_SEND_FAILED' });

      const summary = await service.importMany(
        { vehicles: [{ unitNumber: '#101', vin: 'VIN-A', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0 }], options: { duplicateStrategy: 'UPDATE_BY_VIN', pairDevices: false, emailSummary: true } },
        'usr_1',
      );

      expect(summary).toEqual({ imported: 1, updated: 0, skipped: 0, failed: [] });
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('B-69 emailSummary sends nothing when the caller has no email', async () => {
      vehiclesRepo.findByUnitNumber.mockResolvedValue(null);
      vehiclesRepo.findByVin.mockResolvedValue(null);
      vehiclesRepo.create.mockResolvedValue(makeVehicle() as never);
      users.findById.mockResolvedValue(null);

      await service.importMany(
        { vehicles: [{ unitNumber: '#101', vin: 'VIN-A', fuelType: 'DIESEL', sleeperBerth: false, odometerMi: 0 }], options: { duplicateStrategy: 'UPDATE_BY_VIN', pairDevices: false, emailSummary: true } },
        'usr_1',
      );

      expect(mail.send).not.toHaveBeenCalled();
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

      const [where, data] = vehiclesRepo.update.mock.calls[0];
      expect(where).toEqual({ id: 'veh_1' });
      expect(data).toMatchObject({ status: 'INACTIVE' });
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(vehiclesRepo.delete).not.toHaveBeenCalled();
    });

    it('unassigns the current driver before deactivating the unit', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findOne.mockResolvedValue({ id: 'drv_1' } as never);
      vehiclesRepo.update.mockResolvedValue(makeVehicle({ status: 'INACTIVE' }) as never);

      await service.remove('veh_1');

      expect(driversRepo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { assignedVehicle: { disconnect: true } });
    });

    it('refuses to soft-delete (status -> INACTIVE) an OOS unit with an open critical defect', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);
      vehiclesRepo.findOpenCriticalDefectIds.mockResolvedValue([{ id: 'def_1' }] as never);

      await expect(service.remove('veh_1')).rejects.toThrow(AppException);
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
    });
  });
});
