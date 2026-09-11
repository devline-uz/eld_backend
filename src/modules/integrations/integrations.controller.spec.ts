import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { IntegrationsController } from './integrations.controller';

function permOf(method: keyof IntegrationsController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, IntegrationsController.prototype[method]) as
    | PermRequirement
    | undefined;
}

describe('IntegrationsController permissions', () => {
  it.each([
    ['list', 'READ'],
    ['get', 'READ'],
    ['upsert', 'FULL'],
    ['disconnect', 'FULL'],
  ] as const)('%s requires integrations:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'integrations', level });
  });
});

describe('IntegrationsController — delegates to IntegrationsService', () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ provider: 'mcleod' }),
    upsert: jest.fn().mockResolvedValue({ provider: 'mcleod' }),
    disconnect: jest.fn().mockResolvedValue({ provider: 'mcleod' }),
  };
  const controller = new IntegrationsController(service as never);

  it('list', async () => {
    await controller.list();
    expect(service.list).toHaveBeenCalled();
  });

  it('get', async () => {
    await controller.get('mcleod');
    expect(service.get).toHaveBeenCalledWith('mcleod');
  });

  it('upsert', async () => {
    const dto = { enabled: true, config: {} };
    await controller.upsert('mcleod', dto);
    expect(service.upsert).toHaveBeenCalledWith('mcleod', dto);
  });

  it('disconnect', async () => {
    await controller.disconnect('mcleod');
    expect(service.disconnect).toHaveBeenCalledWith('mcleod');
  });
});
