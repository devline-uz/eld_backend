import { MeController } from './me.controller';

describe('MeController — delegates to UsersService/AuthService', () => {
  const users = {
    get: jest.fn().mockResolvedValue({ id: 'usr_1' }),
    updateMyProfile: jest.fn().mockResolvedValue({ id: 'usr_1' }),
    uploadAvatar: jest.fn().mockResolvedValue({ id: 'usr_1', avatarUrl: 'https://minio.local/x' }),
    deleteAvatar: jest.fn().mockResolvedValue({ id: 'usr_1', avatarUrl: null }),
    getPreferences: jest.fn().mockResolvedValue({ language: 'en' }),
    updatePreferences: jest.fn().mockResolvedValue({ language: 'ru' }),
  };
  const auth = {
    listUserSessions: jest.fn().mockResolvedValue([{ id: 'sess_1', current: true }]),
    revokeUserSession: jest.fn().mockResolvedValue(undefined),
    revokeAllUserSessions: jest.fn().mockResolvedValue(2),
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

  it('sessions lists the current user sessions, passing the caller session id (B-50)', async () => {
    await controller.sessions('usr_1', 'sess_1');
    expect(auth.listUserSessions).toHaveBeenCalledWith('usr_1', 'sess_1');
  });

  it('revokeSession revokes and returns { success: true }', async () => {
    const result = await controller.revokeSession('usr_1', 'sess_1');
    expect(auth.revokeUserSession).toHaveBeenCalledWith('usr_1', 'sess_1');
    expect(result).toEqual({ success: true });
  });

  it('revokeAllSessions signs out every other session and returns { revoked } (B-50)', async () => {
    const result = await controller.revokeAllSessions('usr_1', 'sess_1');
    expect(auth.revokeAllUserSessions).toHaveBeenCalledWith('usr_1', 'sess_1');
    expect(result).toEqual({ revoked: 2 });
  });

  it('uploadAvatar delegates to UsersService with the current user id and file (B-51)', async () => {
    const file = { buffer: Buffer.from(''), mimetype: 'image/png', size: 1 } as never;
    const result = await controller.uploadAvatar('usr_1', file);
    expect(users.uploadAvatar).toHaveBeenCalledWith('usr_1', file);
    expect(result).toEqual({ id: 'usr_1', avatarUrl: 'https://minio.local/x' });
  });

  it('deleteAvatar delegates to UsersService (B-51)', async () => {
    const result = await controller.deleteAvatar('usr_1');
    expect(users.deleteAvatar).toHaveBeenCalledWith('usr_1');
    expect(result).toEqual({ id: 'usr_1', avatarUrl: null });
  });

  it('getPreferences delegates to UsersService (B-11)', async () => {
    const result = await controller.getPreferences('usr_1');
    expect(users.getPreferences).toHaveBeenCalledWith('usr_1');
    expect(result).toEqual({ language: 'en' });
  });

  it('updatePreferences delegates to UsersService (B-11)', async () => {
    const dto = { language: 'ru' } as never;
    const result = await controller.updatePreferences('usr_1', dto);
    expect(users.updatePreferences).toHaveBeenCalledWith('usr_1', dto);
    expect(result).toEqual({ language: 'ru' });
  });
});
