import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { UsersController } from './users.controller';

function permOf(method: keyof UsersController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, UsersController.prototype[method]) as PermRequirement | undefined;
}

const ACTOR = { id: 'admin_1', role: 'SUPER_ADMIN' };

describe('UsersController permissions', () => {
  it.each([
    ['list', 'READ'],
    ['get', 'READ'],
    ['create', 'FULL'],
    ['resendInvite', 'FULL'],
    ['update', 'FULL'],
    ['remove', 'FULL'],
  ] as const)('%s requires users:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'users', level });
  });
});

describe('UsersController — delegates to UsersService', () => {
  const service = {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 'usr_1' }),
    invite: jest.fn().mockResolvedValue({ user: { id: 'usr_1' }, inviteToken: 'tok' }),
    resendInvite: jest.fn().mockResolvedValue({ inviteToken: 'tok' }),
    update: jest.fn().mockResolvedValue({ id: 'usr_1' }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new UsersController(service as never);

  it('list', async () => {
    await controller.list();
    expect(service.list).toHaveBeenCalled();
  });

  it('get', async () => {
    await controller.get('usr_1');
    expect(service.get).toHaveBeenCalledWith('usr_1');
  });

  it('create passes invitedById from CurrentUser', async () => {
    const dto = { email: 'a@b.com', roleId: 'role_1' } as never;
    await controller.create(dto, ACTOR);
    expect(service.invite).toHaveBeenCalledWith(dto, ACTOR);
  });

  it('resendInvite', async () => {
    await controller.resendInvite('usr_1', ACTOR);
    expect(service.resendInvite).toHaveBeenCalledWith('usr_1', ACTOR);
  });

  it('update', async () => {
    const dto = { firstName: 'Jane' } as never;
    await controller.update('usr_1', dto, ACTOR);
    expect(service.update).toHaveBeenCalledWith('usr_1', dto, ACTOR);
  });

  it('remove returns { success: true }', async () => {
    const result = await controller.remove('usr_1', ACTOR);
    expect(service.remove).toHaveBeenCalledWith('usr_1', ACTOR);
    expect(result).toEqual({ success: true });
  });
});
