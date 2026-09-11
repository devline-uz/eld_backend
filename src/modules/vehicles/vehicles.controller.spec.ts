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
    ['assignDriver', 'FULL'],
    ['unassignDriver', 'FULL'],
  ] as const)('%s requires vehicles:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'vehicles', level });
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
    await controller.import(dto);
    expect(service.importMany).toHaveBeenCalledWith(dto);
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
});
