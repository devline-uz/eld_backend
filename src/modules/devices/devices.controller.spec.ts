import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { DevicesController } from './devices.controller';

function permOf(method: keyof DevicesController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, DevicesController.prototype[method]) as
    | PermRequirement
    | undefined;
}

/** TZ §6.4 — every devices.* endpoint must be gated by the `devices` key at the right level. */
describe('DevicesController permissions', () => {
  it.each([
    ['list', 'READ'],
    ['export', 'READ'],
    ['get', 'READ'],
    ['create', 'FULL'],
    ['import', 'FULL'],
    ['update', 'FULL'],
    ['updateFirmware', 'FULL'],
    ['updateBleStatus', 'FULL'],
    ['remove', 'FULL'],
    ['pair', 'FULL'],
    ['unpair', 'FULL'],
  ] as const)('%s requires devices:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'devices', level });
  });
});

describe('DevicesController — delegates to DevicesService', () => {
  const service = {
    list: jest.fn().mockResolvedValue({ items: [], page: 1, limit: 25, total: 0, totalPages: 0 }),
    exportAll: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 'dev_1' }),
    create: jest.fn().mockResolvedValue({ id: 'dev_1' }),
    importMany: jest.fn().mockResolvedValue({ imported: 0, updated: 0, failed: [] }),
    update: jest.fn().mockResolvedValue({ id: 'dev_1' }),
    updateFirmware: jest.fn().mockResolvedValue({ id: 'dev_1' }),
    updateBleStatus: jest.fn().mockResolvedValue({ id: 'dev_1' }),
    remove: jest.fn().mockResolvedValue({ id: 'dev_1' }),
    pair: jest.fn().mockResolvedValue({ id: 'dev_1' }),
    unpair: jest.fn().mockResolvedValue({ id: 'dev_1' }),
  };
  const controller = new DevicesController(service as never);

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
    await controller.get('dev_1');
    expect(service.get).toHaveBeenCalledWith('dev_1');
  });

  it('create', async () => {
    const dto = { serial: 'PT30_X' } as never;
    await controller.create(dto);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('import', async () => {
    const dto = { devices: [] } as never;
    await controller.import(dto);
    expect(service.importMany).toHaveBeenCalledWith(dto);
  });

  it('update', async () => {
    const dto = { status: 'ACTIVE' } as never;
    await controller.update('dev_1', dto);
    expect(service.update).toHaveBeenCalledWith('dev_1', dto);
  });

  it('updateFirmware', async () => {
    const dto = { firmware: '1.2.3' } as never;
    await controller.updateFirmware('dev_1', dto);
    expect(service.updateFirmware).toHaveBeenCalledWith('dev_1', dto);
  });

  it('updateBleStatus', async () => {
    const dto = { bleState: 'CONNECTED' } as never;
    await controller.updateBleStatus('dev_1', dto);
    expect(service.updateBleStatus).toHaveBeenCalledWith('dev_1', dto);
  });

  it('remove', async () => {
    await controller.remove('dev_1');
    expect(service.remove).toHaveBeenCalledWith('dev_1');
  });

  it('pair', async () => {
    const dto = { vehicleId: 'veh_1' } as never;
    await controller.pair('dev_1', dto);
    expect(service.pair).toHaveBeenCalledWith('dev_1', dto);
  });

  it('unpair', async () => {
    await controller.unpair('dev_1');
    expect(service.unpair).toHaveBeenCalledWith('dev_1');
  });
});
