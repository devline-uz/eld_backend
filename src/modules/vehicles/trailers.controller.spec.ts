import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { TrailersController } from './trailers.controller';

function permOf(method: keyof TrailersController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, TrailersController.prototype[method]) as
    | PermRequirement
    | undefined;
}

/** TZ §6.4 — trailers ride on the `vehicles` key (no dedicated key in the 22-key matrix). */
describe('TrailersController permissions', () => {
  it.each([
    ['list', 'READ'],
    ['export', 'READ'],
    ['get', 'READ'],
    ['create', 'FULL'],
    ['import', 'FULL'],
    ['update', 'FULL'],
    ['remove', 'FULL'],
  ] as const)('%s requires vehicles:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'vehicles', level });
  });
});

describe('TrailersController — delegates to TrailersService', () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    exportAll: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 'tr_1' }),
    create: jest.fn().mockResolvedValue({ id: 'tr_1' }),
    importMany: jest.fn().mockResolvedValue({ imported: 0, updated: 0, failed: [] }),
    update: jest.fn().mockResolvedValue({ id: 'tr_1' }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new TrailersController(service as never);

  it('list', async () => {
    await controller.list();
    expect(service.list).toHaveBeenCalled();
  });

  it('export', async () => {
    await controller.export();
    expect(service.exportAll).toHaveBeenCalled();
  });

  it('get', async () => {
    await controller.get('tr_1');
    expect(service.get).toHaveBeenCalledWith('tr_1');
  });

  it('create', async () => {
    const dto = { number: 'TR-1', vin: 'VIN1' };
    await controller.create(dto);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('import', async () => {
    const dto = { trailers: [] } as never;
    await controller.import(dto);
    expect(service.importMany).toHaveBeenCalledWith(dto);
  });

  it('update', async () => {
    const dto = { number: 'TR-2' } as never;
    await controller.update('tr_1', dto);
    expect(service.update).toHaveBeenCalledWith('tr_1', dto);
  });

  it('remove returns { success: true }', async () => {
    const result = await controller.remove('tr_1');
    expect(service.remove).toHaveBeenCalledWith('tr_1');
    expect(result).toEqual({ success: true });
  });
});
