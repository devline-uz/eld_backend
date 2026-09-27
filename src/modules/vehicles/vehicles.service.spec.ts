import { AppException } from '../../common/errors/app.exception';
import type { FirebaseService } from '../../core/firebase/firebase.service';
import type { CarrierRepository } from '../carrier/carrier.repository';
import { DriversRepository } from '../drivers/drivers.repository';
import type { MobileRepository } from '../mobile/mobile.repository';
import type { NotificationsRepository } from '../notifications/notifications.repository';
import type { MailPort } from '../transfers/mail.port';
import type { UsersRepository } from '../users/users.repository';
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
    >
  >;
  let driversRepo: jest.Mocked<Pick<DriversRepository, 'findById' | 'update' | 'findOne'>>;
  let notifications: jest.Mocked<Pick<NotificationsRepository, 'create'>>;
  let carrier: jest.Mocked<Pick<CarrierRepository, 'get'>>;
  let users: jest.Mocked<Pick<UsersRepository, 'findById'>>;
  let mail: jest.Mocked<MailPort>;
  let mobile: jest.Mocked<Pick<MobileRepository, 'findPushTokens'>>;
  let firebase: jest.Mocked<Pick<FirebaseService, 'enabled' | 'sendToToken'>>;
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
      findOpenCriticalDefectIds: jest.fn().mockResolvedValue([]),
      findAuditRows: jest.fn().mockResolvedValue([]),
      findDvirRows: jest.fn().mockResolvedValue([]),
      findDeviceBySerial: jest.fn(),
      pairDevice: jest.fn(),
      groupExists: jest.fn().mockResolvedValue(true),
      findTelemetryRange: jest.fn().mockResolvedValue([]),
      findTelemetryRecent: jest.fn().mockResolvedValue([]),
    };
    driversRepo = {
      findById: jest.fn(),
      update: jest.fn(),
      findOne: jest.fn().mockResolvedValue(null),
    };
    notifications = { create: jest.fn() };
    carrier = { get: jest.fn().mockResolvedValue({ timezone: 'America/New_York' }) };
    users = { findById: jest.fn() };
    mail = { send: jest.fn().mockResolvedValue({ delivered: false, reference: 'not-configured' }) };
    mobile = { findPushTokens: jest.fn().mockResolvedValue([]) };
    firebase = { enabled: false, sendToToken: jest.fn().mockResolvedValue(undefined) };
    service = new VehiclesService(
      vehiclesRepo as unknown as VehiclesRepository,
      driversRepo as unknown as DriversRepository,
      notifications as unknown as NotificationsRepository,
      carrier as unknown as CarrierRepository,
      users as unknown as UsersRepository,
      mobile as unknown as MobileRepository,
      firebase as unknown as FirebaseService,
      mail,
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
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });

      expect(driversRepo.update).toHaveBeenCalledWith({ id: 'drv_1' }, { assignedVehicle: { connect: { id: 'veh_1' } } });
    });

    it('surfaces a conflict when the unit is already assigned to another driver', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null } as never);
      driversRepo.update.mockRejectedValue(new Error('Unique constraint failed'));

      await expect(service.assignDriver('veh_1', { driverId: 'drv_1', notify: true })).rejects.toThrow(AppException);
    });
  });

  describe('assignDriver — B-74 notify', () => {
    it('creates a notification when notify is true', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });

      expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('never creates a notification when notify is false', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: false });

      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('pushes FCM to every active token when notify is true and Firebase is enabled (§12.7 background app)', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);
      notifications.create.mockResolvedValue({ id: 'ntf_1' } as never);
      (firebase as { enabled: boolean }).enabled = true;
      mobile.findPushTokens.mockResolvedValue([{ token: 'tok_a' }, { token: 'tok_b' }] as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });

      expect(mobile.findPushTokens).toHaveBeenCalledWith('drv_1');
      expect(firebase.sendToToken).toHaveBeenCalledTimes(2);
      expect(firebase.sendToToken).toHaveBeenCalledWith(
        'tok_a',
        expect.objectContaining({ title: 'New unit assignment' }),
        expect.objectContaining({ type: 'ASSIGNMENT', id: 'ntf_1', driverId: 'drv_1' }),
      );
    });

    it('never touches push tokens when Firebase is disabled', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle() as never);
      driversRepo.findById.mockResolvedValue({ id: 'drv_1', assignedVehicleId: null } as never);
      driversRepo.update.mockResolvedValue({} as never);

      await service.assignDriver('veh_1', { driverId: 'drv_1', notify: true });

      expect(mobile.findPushTokens).not.toHaveBeenCalled();
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

    it('refuses to soft-delete (status -> INACTIVE) an OOS unit with an open critical defect', async () => {
      vehiclesRepo.findById.mockResolvedValue(makeVehicle({ status: 'OUT_OF_SERVICE' }) as never);
      vehiclesRepo.findOpenCriticalDefectIds.mockResolvedValue([{ id: 'def_1' }] as never);

      await expect(service.remove('veh_1')).rejects.toThrow(AppException);
      expect(vehiclesRepo.update).not.toHaveBeenCalled();
    });
  });
});
