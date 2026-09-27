import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { VehiclesController } from './vehicles.controller';

function permOf(method: keyof VehiclesController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, VehiclesController.prototype[method]) as
    | PermRequirement
    | undefined;
}

/** TZ §6.4 — every vehicles.* endpoint must be gated by the `vehicles` key at the right level. */
describe('VehiclesController permissions', () => {
  it.each([
    ['list', 'READ'],
    ['export', 'READ'],
    ['get', 'READ'],
    ['create', 'FULL'],
    ['import', 'FULL'],
    ['update', 'FULL'],
    ['remove', 'FULL'],
    ['calibrateOdometer', 'FULL'],
    ['unassignDriver', 'FULL'],
    ['activities', 'READ'],
    ['histories', 'READ'],
    ['telemetry', 'READ'],
    ['bulkUpdateStatus', 'FULL'],
  ] as const)('%s requires vehicles:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'vehicles', level });
  });

  it('assignDriver accepts vehicles:FULL OR trips:FULL (B-13 — a dispatcher may assign a driver)', () => {
    expect(Reflect.getMetadata(PERM_METADATA_KEY, VehiclesController.prototype.assignDriver)).toEqual([
      { key: 'vehicles', level: 'FULL' },
      { key: 'trips', level: 'FULL' },
    ]);
  });
});

describe('VehiclesController — delegates to VehiclesService', () => {
  const service = {
    list: jest.fn().mockResolvedValue({ items: [], page: 1, limit: 25, total: 0, totalPages: 0 }),
    exportAll: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 'veh_1' }),
    create: jest.fn().mockResolvedValue({ id: 'veh_1' }),
    importMany: jest.fn().mockResolvedValue({ imported: 0, updated: 0, failed: [] }),
    update: jest.fn().mockResolvedValue({ id: 'veh_1' }),
    remove: jest.fn().mockResolvedValue({ id: 'veh_1' }),
    calibrateOdometer: jest.fn().mockResolvedValue({ id: 'veh_1' }),
    assignDriver: jest.fn().mockResolvedValue({ id: 'veh_1' }),
    unassignDriver: jest.fn().mockResolvedValue({ id: 'veh_1' }),
    activities: jest.fn().mockResolvedValue([]),
    histories: jest.fn().mockResolvedValue({ date: '2026-09-24' }),
    telemetryRecent: jest.fn().mockResolvedValue([]),
    bulkUpdateStatus: jest.fn().mockResolvedValue({ updated: [], failed: [] }),
  };
  const controller = new VehiclesController(service as never);

  it('list', async () => {
    const query = { page: 1, limit: 25 } as never;
    await controller.list(query);
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('export', async () => {
    await controller.export();
    expect(service.exportAll).toHaveBeenCalled();
  });

  it('get', async () => {
    await controller.get('veh_1');
    expect(service.get).toHaveBeenCalledWith('veh_1');
  });

  it('create', async () => {
    const dto = { unitNumber: '#101' } as never;
    await controller.create(dto);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('import', async () => {
    const dto = { vehicles: [] } as never;
    await controller.import(dto, 'usr_1');
    expect(service.importMany).toHaveBeenCalledWith(dto, 'usr_1');
  });

  it('update', async () => {
    const dto = { make: 'Volvo' } as never;
    await controller.update('veh_1', dto);
    expect(service.update).toHaveBeenCalledWith('veh_1', dto);
  });

  it('remove', async () => {
    await controller.remove('veh_1');
    expect(service.remove).toHaveBeenCalledWith('veh_1');
  });

  it('calibrateOdometer', async () => {
    const dto = { odometerMi: 100 } as never;
    await controller.calibrateOdometer('veh_1', dto);
    expect(service.calibrateOdometer).toHaveBeenCalledWith('veh_1', dto);
  });

  it('assignDriver', async () => {
    const dto = { driverId: 'drv_1' } as never;
    await controller.assignDriver('veh_1', dto);
    expect(service.assignDriver).toHaveBeenCalledWith('veh_1', dto);
  });

  it('unassignDriver', async () => {
    await controller.unassignDriver('veh_1');
    expect(service.unassignDriver).toHaveBeenCalledWith('veh_1');
  });

  it('activities wraps the array in { items }', async () => {
    const result = await controller.activities('veh_1');
    expect(service.activities).toHaveBeenCalledWith('veh_1');
    expect(result).toEqual({ items: [] });
  });

  it('histories', async () => {
    await controller.histories('veh_1', { date: '2026-09-24' });
    expect(service.histories).toHaveBeenCalledWith('veh_1', '2026-09-24');
  });

  it('telemetry wraps the array in { items }', async () => {
    const query = { limit: 500 } as never;
    const result = await controller.telemetry('veh_1', query);
    expect(service.telemetryRecent).toHaveBeenCalledWith('veh_1', query);
    expect(result).toEqual({ items: [] });
  });

  it('bulkUpdateStatus', async () => {
    const dto = { ids: ['veh_1'], status: 'INACTIVE' } as never;
    await controller.bulkUpdateStatus(dto);
    expect(service.bulkUpdateStatus).toHaveBeenCalledWith(dto);
  });
});
