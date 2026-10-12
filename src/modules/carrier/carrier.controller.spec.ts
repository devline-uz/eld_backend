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
    view: jest.fn().mockResolvedValue({ id: 'carrier', virtualEldAvailable: true }),
    update: jest.fn().mockResolvedValue({ id: 'carrier', name: 'New Name' }),
    getTransferConfig: jest.fn().mockResolvedValue({ erodsMode: 'TEST' }),
  };
  const controller = new CarrierController(service as never);

  it('get returns the view with virtualEldAvailable (pt30_pt40/tz.md §9.3)', async () => {
    await expect(controller.get()).resolves.toMatchObject({ virtualEldAvailable: true });
    expect(service.view).toHaveBeenCalled();
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
