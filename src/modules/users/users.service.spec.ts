import { AppException } from '../../common/errors/app.exception';
import type { StoragePort } from '../../core/storage/storage.port';
import type { AttachmentsService } from '../attachments/attachments.service';
import { AuthService } from '../auth/auth.service';
import { RolesRepository } from '../roles/roles.repository';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'usr_1',
    email: 'a@b.com',
    firstName: 'Sarah',
    lastName: 'Chen',
    jobTitle: null,
    phone: null,
    status: 'ACTIVE',
    passwordHash: 'hash',
    role: { id: 'role_1', key: 'ADMIN' },
    ...overrides,
  };
}

describe('UsersService', () => {
  let users: jest.Mocked<Pick<UsersRepository, 'listWithRoles' | 'findByIdWithRole' | 'findByEmail' | 'create' | 'update' | 'delete' | 'countActiveAdmins'>>;
  let roles: jest.Mocked<Pick<RolesRepository, 'findById'>>;
  let auth: jest.Mocked<Pick<AuthService, 'issueResetToken' | 'issueUserEmailVerifyToken'>>;
  let storage: jest.Mocked<Pick<StoragePort, 'put' | 'get' | 'delete' | 'exists' | 'presignPut' | 'presignGet'>>;
  let attachments: jest.Mocked<Pick<AttachmentsService, 'presignKey'>>;
  let service: UsersService;

  beforeEach(() => {
    users = {
      listWithRoles: jest.fn(),
      findByIdWithRole: jest.fn(),
      findByEmail: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      countActiveAdmins: jest.fn().mockResolvedValue(2),
    };
    roles = { findById: jest.fn() };
    auth = {
      issueResetToken: jest.fn().mockReturnValue('invite-token'),
      issueUserEmailVerifyToken: jest.fn().mockReturnValue('verify-token'),
    };
    storage = {
      put: jest.fn().mockResolvedValue('avatars/usr_1/x.png'),
      get: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn(),
      presignPut: jest.fn(),
      presignGet: jest.fn().mockResolvedValue('https://minio.local/signed'),
    };
    attachments = {
      presignKey: jest.fn().mockResolvedValue({ url: 'https://minio.local/signed', expiresAt: '2026-01-01T00:00:00.000Z' }),
    };
    service = new UsersService(
      users as unknown as UsersRepository,
      roles as unknown as RolesRepository,
      auth as unknown as AuthService,
      storage,
      attachments as unknown as AttachmentsService,
    );
  });

  it('list passes through the lean rows the repository already selected (perf: no passwordHash/permissions round-trip)', async () => {
    const lean = { id: 'usr_1', email: 'a@b.com', firstName: 'Sarah', lastName: 'Chen', status: 'ACTIVE', role: { id: 'role_1', key: 'ADMIN', name: 'Administrator' } };
    users.listWithRoles.mockResolvedValue([lean] as never);
    const result = await service.list();
    expect(result).toEqual([lean]);
  });

  describe('get', () => {
    it('throws notFound when missing', async () => {
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.get('missing')).rejects.toThrow(AppException);
    });

    it('returns the stripped view', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      const result = await service.get('usr_1');
      expect(result.email).toBe('a@b.com');
      expect(result).not.toHaveProperty('passwordHash');
    });
  });

  describe('invite', () => {
    it('throws notFound when the role does not exist', async () => {
      roles.findById.mockResolvedValue(null);
      await expect(service.invite({ email: 'x@y.com', roleId: 'missing' } as never, 'admin_1')).rejects.toThrow(
        AppException,
      );
    });

    it('throws conflict when the email is already taken', async () => {
      roles.findById.mockResolvedValue({ id: 'role_1', key: 'VIEWER' } as never);
      users.findByEmail.mockResolvedValue(makeUser() as never);
      await expect(service.invite({ email: 'a@b.com', roleId: 'role_1' } as never, 'admin_1')).rejects.toThrow(
        AppException,
      );
    });

    it('creates the user and returns an inviteToken', async () => {
      roles.findById.mockResolvedValue({ id: 'role_1', key: 'VIEWER' } as never);
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser({ role: undefined }) as never);

      const result = await service.invite(
        { email: 'new@b.com', firstName: 'New', lastName: 'User', roleId: 'role_1' },
        'admin_1',
      );

      expect(result.inviteToken).toBe('invite-token');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(auth.issueResetToken).toHaveBeenCalledWith('usr_1', null);
    });

    it('B-85 — passes terminalIds through to terminalScope', async () => {
      roles.findById.mockResolvedValue({ id: 'role_1', key: 'VIEWER' } as never);
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser({ role: undefined }) as never);

      await service.invite(
        { email: 'new@b.com', firstName: 'New', lastName: 'User', roleId: 'role_1', terminalIds: ['Dallas', 'Reno'] },
        'admin_1',
      );

      expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ terminalScope: ['Dallas', 'Reno'] }));
    });
  });

  describe('resendInvite', () => {
    it('throws when user missing', async () => {
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.resendInvite('missing')).rejects.toThrow(AppException);
    });

    it('reissues a reset token bound to the current password hash', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      const result = await service.resendInvite('usr_1');
      expect(result.inviteToken).toBe('invite-token');
      expect(auth.issueResetToken).toHaveBeenCalledWith('usr_1', 'hash');
      expect(users.update).not.toHaveBeenCalled();
    });

    it('restarts the invite window for a user still INVITED', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ status: 'INVITED' }) as never);
      await service.resendInvite('usr_1');
      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { invitedAt: expect.any(Date) });
    });
  });

  describe('update', () => {
    it('throws when user missing', async () => {
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.update('missing', {})).rejects.toThrow(AppException);
    });

    it('throws notFound when the new role does not exist', async () => {
      users.findByIdWithRole.mockResolvedValueOnce(makeUser() as never);
      roles.findById.mockResolvedValue(null);
      await expect(service.update('usr_1', { roleId: 'missing' })).rejects.toThrow(AppException);
    });

    it('applies a partial diff including a role change', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      roles.findById.mockResolvedValue({ id: 'role_2', key: 'VIEWER' } as never);
      users.update.mockResolvedValue({} as never);

      await service.update('usr_1', { firstName: 'Jane', roleId: 'role_2', status: 'ACTIVE' } as never);

      expect(users.update).toHaveBeenCalledWith(
        { id: 'usr_1' },
        { firstName: 'Jane', role: { connect: { id: 'role_2' } }, status: 'ACTIVE' },
      );
    });

    it('refuses to demote or disable the last active admin (409)', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ status: 'ACTIVE', role: { id: 'role_admin', key: 'ADMIN' } }) as never);
      users.countActiveAdmins.mockResolvedValue(1);
      roles.findById.mockResolvedValue({ id: 'role_2', key: 'VIEWER' } as never);
      await expect(service.update('usr_1', { roleId: 'role_2' })).rejects.toThrow('last active admin');
      await expect(service.update('usr_1', { status: 'DISABLED' } as never)).rejects.toThrow('last active admin');
      expect(users.update).not.toHaveBeenCalled();
    });

    it('lets the last admin edit their own profile fields', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ status: 'ACTIVE', role: { id: 'role_admin', key: 'ADMIN' } }) as never);
      users.countActiveAdmins.mockResolvedValue(1);
      users.update.mockResolvedValue({} as never);
      await service.update('usr_1', { firstName: 'Jane' });
      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { firstName: 'Jane' });
    });

    it('applies homeTerminalName directly (no re-verification needed)', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      users.update.mockResolvedValue({} as never);
      await service.update('usr_1', { homeTerminalName: 'Dallas, TX' });
      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { homeTerminalName: 'Dallas, TX' });
    });

    it('B-84 — an email change does not touch User.email; it issues a re-verification token instead', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ email: 'old@b.com' }) as never);
      users.findByEmail.mockResolvedValue(null);
      users.update.mockResolvedValue({} as never);

      const result = await service.update('usr_1', { email: 'new@b.com' });

      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, {});
      expect(auth.issueUserEmailVerifyToken).toHaveBeenCalledWith('usr_1', 'new@b.com');
      expect(result.emailVerification).toEqual({ pendingEmail: 'new@b.com', verifyToken: 'verify-token' });
    });

    it('B-84 — throws conflict when the new email is already taken by someone else', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ email: 'old@b.com' }) as never);
      users.findByEmail.mockResolvedValue(makeUser({ id: 'usr_2', email: 'new@b.com' }) as never);
      await expect(service.update('usr_1', { email: 'new@b.com' })).rejects.toThrow(AppException);
    });

    it('B-84 — no-op when the email in the dto matches the current email', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ email: 'same@b.com' }) as never);
      users.update.mockResolvedValue({} as never);
      const result = await service.update('usr_1', { email: 'same@b.com' });
      expect(auth.issueUserEmailVerifyToken).not.toHaveBeenCalled();
      expect(result.emailVerification).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('throws when user missing', async () => {
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toThrow(AppException);
    });

    it('deletes when found', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      users.delete.mockResolvedValue({} as never);
      await service.remove('usr_1');
      expect(users.delete).toHaveBeenCalledWith({ id: 'usr_1' });
    });
  });

  it('updateMyProfile applies the dto and returns the fresh view', async () => {
    users.update.mockResolvedValue({} as never);
    users.findByIdWithRole.mockResolvedValue(makeUser({ phone: '555-1212' }) as never);
    const result = await service.updateMyProfile('usr_1', { phone: '555-1212' });
    expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { phone: '555-1212' });
    expect(result.phone).toBe('555-1212');
  });

  describe('isRoleChange', () => {
    it('is true when roleId is present', () => {
      expect(service.isRoleChange({ roleId: 'role_2' })).toBe(true);
    });

    it('is false when roleId is absent', () => {
      expect(service.isRoleChange({})).toBe(false);
    });
  });

  describe('avatar (B-51)', () => {
    function fakePng(width: number, height: number): Buffer {
      const buf = Buffer.alloc(33);
      buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      buf.writeUInt32BE(13, 8);
      buf.write('IHDR', 12, 'ascii');
      buf.writeUInt32BE(width, 16);
      buf.writeUInt32BE(height, 20);
      return buf;
    }

    it('rejects a missing file', async () => {
      await expect(service.uploadAvatar('usr_1', undefined)).rejects.toThrow(AppException);
    });

    it('rejects an image smaller than 256x256', async () => {
      const file = { buffer: fakePng(100, 100), mimetype: 'image/png', size: 33 };
      await expect(service.uploadAvatar('usr_1', file)).rejects.toMatchObject({ code: 'IMAGE_TOO_SMALL' });
    });

    it('rejects a non-image buffer', async () => {
      const file = { buffer: Buffer.from('not an image'), mimetype: 'image/png', size: 12 };
      await expect(service.uploadAvatar('usr_1', file)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
    });

    it('B-095 — rejects a declared pixel size above 8192 (decompression bomb)', async () => {
      const file = { buffer: fakePng(65535, 65535), mimetype: 'image/png', size: 33 };
      await expect(service.uploadAvatar('usr_1', file)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('rejects an oversized upload', async () => {
      const file = { buffer: fakePng(512, 512), mimetype: 'image/png', size: 6 * 1024 * 1024 };
      await expect(service.uploadAvatar('usr_1', file)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    });

    it('stores a valid PNG, deletes the previous object, and returns the fresh view with avatarUrl', async () => {
      users.findByIdWithRole
        .mockResolvedValueOnce(makeUser({ avatarKey: 'avatars/usr_1/old.png' }) as never) // getRaw (current)
        .mockResolvedValueOnce(makeUser({ avatarKey: 'avatars/usr_1/new.png' }) as never); // get (fresh view)
      users.update.mockResolvedValue({} as never);

      const file = { buffer: fakePng(512, 512), mimetype: 'image/png', size: 33 };
      const result = await service.uploadAvatar('usr_1', file);

      const [putKey] = storage.put.mock.calls[0] as [string, Buffer, unknown];
      expect(putKey).toMatch(/^avatars\/usr_1\/.+\.png$/);
      expect(storage.put).toHaveBeenCalledWith(putKey, file.buffer, { contentType: 'image/png' });
      const [, updateData] = users.update.mock.calls[0] as [{ id: string }, { avatarKey: string }];
      expect(updateData.avatarKey).toMatch(/^avatars\/usr_1\//);
      expect(storage.delete).toHaveBeenCalledWith('avatars/usr_1/old.png');
      expect(result.avatarUrl).toBe('https://minio.local/signed');
    });

    it('deleteAvatar clears avatarKey and deletes the object when one exists', async () => {
      users.findByIdWithRole
        .mockResolvedValueOnce(makeUser({ avatarKey: 'avatars/usr_1/old.png' }) as never)
        .mockResolvedValueOnce(makeUser({ avatarKey: null }) as never);
      users.update.mockResolvedValue({} as never);

      await service.deleteAvatar('usr_1');

      expect(storage.delete).toHaveBeenCalledWith('avatars/usr_1/old.png');
      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { avatarKey: null });
    });

    it('deleteAvatar is a no-op when there is no avatar', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ avatarKey: null }) as never);
      await service.deleteAvatar('usr_1');
      expect(storage.delete).not.toHaveBeenCalled();
      expect(users.update).not.toHaveBeenCalled();
    });
  });

  describe('preferences (B-11)', () => {
    it('getPreferences returns {} when unset', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ preferences: null }) as never);
      await expect(service.getPreferences('usr_1')).resolves.toEqual({});
    });

    it('getPreferences returns the stored blob', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ preferences: { language: 'en', distanceUnit: 'MILES' } }) as never);
      await expect(service.getPreferences('usr_1')).resolves.toEqual({ language: 'en', distanceUnit: 'MILES' });
    });

    it('updatePreferences persists and echoes the new blob', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      users.update.mockResolvedValue({} as never);
      const dto = { language: 'en', timezone: 'America/Chicago' };
      const result = await service.updatePreferences('usr_1', dto);
      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { preferences: dto });
      expect(result).toEqual(dto);
    });
  });
});
