import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { DriversController } from './drivers.controller';

function permOf(method: keyof DriversController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, DriversController.prototype[method]) as
    | PermRequirement
    | undefined;
}

/** TZ §6.4 — every drivers.* endpoint must be gated by the `drivers` key at the right level. */
describe('DriversController permissions', () => {
  it.each([
    ['list', 'READ'],
    ['export', 'READ'],
    ['get', 'READ'],
    ['create', 'FULL'],
    ['import', 'FULL'],
    ['update', 'FULL'],
    ['remove', 'FULL'],
  ] as const)('%s requires drivers:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'drivers', level });
  });
});

describe('DriversController — delegates to DriversService', () => {
  const service = {
    list: jest.fn().mockResolvedValue({ items: [], page: 1, limit: 25, total: 0, totalPages: 0 }),
    exportAll: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 'drv_1' }),
    create: jest.fn().mockResolvedValue({ id: 'drv_1' }),
    importMany: jest.fn().mockResolvedValue({ imported: 0, updated: 0, failed: [] }),
    update: jest.fn().mockResolvedValue({ id: 'drv_1' }),
    remove: jest.fn().mockResolvedValue({ id: 'drv_1' }),
  };
  const controller = new DriversController(service as never);

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
    await controller.get('drv_1');
    expect(service.get).toHaveBeenCalledWith('drv_1');
  });

  it('create', async () => {
    const dto = { username: 'jsmith' } as never;
    await controller.create(dto);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('import', async () => {
    const dto = { drivers: [] } as never;
    await controller.import(dto);
    expect(service.importMany).toHaveBeenCalledWith(dto);
  });

  it('update', async () => {
    const dto = { firstName: 'Jane' } as never;
    await controller.update('drv_1', dto);
    expect(service.update).toHaveBeenCalledWith('drv_1', dto);
  });

  it('remove', async () => {
    await controller.remove('drv_1');
    expect(service.remove).toHaveBeenCalledWith('drv_1');
  });
});
