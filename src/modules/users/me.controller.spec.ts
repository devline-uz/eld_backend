import { MeController } from './me.controller';

describe('MeController — delegates to UsersService/AuthService', () => {
  const users = {
    get: jest.fn().mockResolvedValue({ id: 'usr_1' }),
    updateMyProfile: jest.fn().mockResolvedValue({ id: 'usr_1' }),
  };
  const auth = {
    listUserSessions: jest.fn().mockResolvedValue([{ id: 'sess_1' }]),
    revokeUserSession: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new MeController(users as never, auth as never);

  it('profile reads the current user by id', async () => {
    await controller.profile('usr_1');
    expect(users.get).toHaveBeenCalledWith('usr_1');
  });

  it('updateProfile applies the dto for the current user', async () => {
    const dto = { phone: '555-1212' } as never;
    await controller.updateProfile('usr_1', dto);
    expect(users.updateMyProfile).toHaveBeenCalledWith('usr_1', dto);
  });

  it('sessions lists the current user sessions', async () => {
    await controller.sessions('usr_1');
    expect(auth.listUserSessions).toHaveBeenCalledWith('usr_1');
  });

  it('revokeSession revokes and returns { success: true }', async () => {
    const result = await controller.revokeSession('usr_1', 'sess_1');
    expect(auth.revokeUserSession).toHaveBeenCalledWith('usr_1', 'sess_1');
    expect(result).toEqual({ success: true });
  });
});
