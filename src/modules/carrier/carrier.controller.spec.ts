import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { CarrierController } from './carrier.controller';

function permOf(method: keyof CarrierController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, CarrierController.prototype[method]) as
    | PermRequirement
    | undefined;
}

/** TZ §6.4 — carrierSettings is ADMIN-only. */
describe('CarrierController permissions', () => {
  it.each([
    ['get', 'READ'],
    ['update', 'FULL'],
  ] as const)('%s requires carrierSettings:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'carrierSettings', level });
  });

  it('B-45: getTransferConfig is readable with reports:READ, not carrierSettings', () => {
    expect(permOf('getTransferConfig')).toEqual({ key: 'reports', level: 'READ' });
  });
});

describe('CarrierController — delegates to CarrierService', () => {
  const service = {
    get: jest.fn().mockResolvedValue({ id: 'carrier' }),
    update: jest.fn().mockResolvedValue({ id: 'carrier', name: 'New Name' }),
    getTransferConfig: jest.fn().mockResolvedValue({ erodsMode: 'TEST' }),
  };
  const controller = new CarrierController(service as never);

  it('get', async () => {
    await controller.get();
    expect(service.get).toHaveBeenCalled();
  });

  it('getTransferConfig', async () => {
    await expect(controller.getTransferConfig()).resolves.toEqual({ erodsMode: 'TEST' });
  });

  it('update', async () => {
    const dto = { name: 'New Name' };
    await controller.update(dto);
    expect(service.update).toHaveBeenCalledWith(dto);
  });
});
