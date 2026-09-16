import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { DashboardController } from './dashboard.controller';

function permOf(method: keyof DashboardController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, DashboardController.prototype[method]) as
    | PermRequirement
    | undefined;
}

/** TZ §6.4 — dashboard is READ for every role. */
describe('DashboardController permissions', () => {
  it('summary requires dashboard:READ', () => {
    expect(permOf('summary')).toEqual({ key: 'dashboard', level: 'READ' });
  });
});

describe('DashboardController — delegates to DashboardService', () => {
  const service = { summary: jest.fn().mockResolvedValue({ liveFleet: { items: [] } }) };
  const controller = new DashboardController(service as never);

  it('summary', async () => {
    const actor = { id: 'usr_1', type: 'user' } as never;
    await controller.summary(actor);
    expect(service.summary).toHaveBeenCalledWith(actor);
  });
});
