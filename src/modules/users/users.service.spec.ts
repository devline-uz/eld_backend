import { AppException } from '../../common/errors/app.exception';
import type { AppConfigService } from '../../core/config/config.service';
import type { TransactionalMailPort } from '../../core/mail/mail.port';
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
    role: { id: 'role_1', key: 'ADMIN', name: 'Administrator' },
    ...overrides,
  };
}

const SA = { id: 'sa_1', role: 'SUPER_ADMIN' };
const ADM = { id: 'adm_1', role: 'ADMIN' };

describe('UsersService', () => {
  let users: jest.Mocked<Pick<UsersRepository, 'listWithRoles' | 'findByIdWithRole' | 'findByEmail' | 'create' | 'update' | 'delete' | 'countActiveAdmins' | 'countActiveSuperAdmins'>>;
  let roles: jest.Mocked<Pick<RolesRepository, 'findById'>>;
  let auth: jest.Mocked<Pick<AuthService, 'issueResetToken' | 'issueUserEmailVerifyToken'>>;
  let storage: jest.Mocked<Pick<StoragePort, 'put' | 'get' | 'delete' | 'exists' | 'presignPut' | 'presignGet'>>;
  let attachments: jest.Mocked<Pick<AttachmentsService, 'presignKey'>>;
  let mail: jest.Mocked<TransactionalMailPort>;
  let config: { get: jest.Mock; echoOneTimeSecrets: boolean };
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
      countActiveSuperAdmins: jest.fn().mockResolvedValue(2),
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
    mail = { send: jest.fn().mockResolvedValue({ delivered: true, reference: 'msg-1' }) };
    config = { get: jest.fn().mockReturnValue('https://panel.example.com'), echoOneTimeSecrets: false };
    service = new UsersService(
      users as unknown as UsersRepository,
      roles as unknown as RolesRepository,
      auth as unknown as AuthService,
      storage,
      attachments as unknown as AttachmentsService,
      mail,
      config as unknown as AppConfigService,
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
      await expect(service.invite({ email: 'x@y.com', roleId: 'missing' } as never, SA)).rejects.toThrow(
        AppException,
      );
    });

    it('throws conflict when the email is already taken', async () => {
      roles.findById.mockResolvedValue({ id: 'role_1', key: 'VIEWER', name: 'Viewer' } as never);
      users.findByEmail.mockResolvedValue(makeUser() as never);
      await expect(service.invite({ email: 'a@b.com', roleId: 'role_1' } as never, SA)).rejects.toThrow(
        AppException,
      );
    });

    it('creates the user and emails the invite without echoing the token', async () => {
      roles.findById.mockResolvedValue({ id: 'role_1', key: 'VIEWER', name: 'Viewer' } as never);
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser({ role: undefined, email: 'new@b.com', invitedById: SA, invitedAt: new Date() }) as never);
      users.findByIdWithRole.mockResolvedValue(makeUser({ firstName: 'Ada', lastName: 'Admin' }) as never);

      const result = await service.invite(
        { email: 'new@b.com', firstName: 'New', lastName: 'User', roleId: 'role_1', message: 'Welcome aboard' },
        SA,
      );

      expect(result.emailDelivered).toBe(true);
      expect(result).not.toHaveProperty('inviteToken');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(auth.issueResetToken).not.toHaveBeenCalled();
      const [sent] = mail.send.mock.calls[0];
      expect(sent.to).toBe('new@b.com');
      expect(sent.text).toContain('Ada Admin has invited you');
      expect(sent.text).toContain('as Viewer');
      expect(sent.text).toContain('Welcome aboard');
      expect(sent.text).toContain('https://panel.example.com/sign-in');
    });

    it('reports emailDelivered=false when the mail is not sent, and still creates the user', async () => {
      roles.findById.mockResolvedValue({ id: 'role_1', key: 'VIEWER', name: 'Viewer' } as never);
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser({ role: undefined, invitedById: null }) as never);
      mail.send.mockResolvedValue({ delivered: false, reference: 'NO_MAIL_TRANSPORT' });

      const result = await service.invite(
        { email: 'new@b.com', firstName: 'New', lastName: 'User', roleId: 'role_1' },
        SA,
      );

      expect(result.emailDelivered).toBe(false);
      expect(result.user.id).toBe('usr_1');
    });

    it('echoes the inviteToken only when one-time secrets may be echoed', async () => {
      config.echoOneTimeSecrets = true;
      roles.findById.mockResolvedValue({ id: 'role_1', key: 'VIEWER', name: 'Viewer' } as never);
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser({ role: undefined, passwordHash: null }) as never);

      const result = await service.invite(
        { email: 'new@b.com', firstName: 'New', lastName: 'User', roleId: 'role_1' },
        SA,
      );

      expect(result.inviteToken).toBe('invite-token');
      expect(auth.issueResetToken).toHaveBeenCalledWith('usr_1', null);
    });

    it('B-85 — passes terminalIds through to terminalScope', async () => {
      roles.findById.mockResolvedValue({ id: 'role_1', key: 'VIEWER', name: 'Viewer' } as never);
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser({ role: undefined }) as never);

      await service.invite(
        { email: 'new@b.com', firstName: 'New', lastName: 'User', roleId: 'role_1', terminalIds: ['Dallas', 'Reno'] },
        SA,
      );

      expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ terminalScope: ['Dallas', 'Reno'] }));
    });
  });

  describe('resendInvite', () => {
    it('throws when user missing', async () => {
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.resendInvite('missing', SA)).rejects.toThrow(AppException);
    });

    it('throws conflict for a user who is no longer INVITED', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      await expect(service.resendInvite('usr_1', SA)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(users.update).not.toHaveBeenCalled();
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('restarts the invite window and re-sends the email', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ status: 'INVITED', invitedById: null }) as never);
      const result = await service.resendInvite('usr_1', SA);
      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { invitedAt: expect.any(Date) as Date });
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.com' }));
      expect(result).toEqual({ emailDelivered: true });
    });

    it('echoes a reset token bound to the current password hash when allowed', async () => {
      config.echoOneTimeSecrets = true;
      users.findByIdWithRole.mockResolvedValue(makeUser({ status: 'INVITED' }) as never);
      const result = await service.resendInvite('usr_1', SA);
      expect(result.inviteToken).toBe('invite-token');
      expect(auth.issueResetToken).toHaveBeenCalledWith('usr_1', 'hash');
    });
  });

  describe('update', () => {
    it('throws when user missing', async () => {
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.update('missing', {}, SA)).rejects.toThrow(AppException);
    });

    it('throws notFound when the new role does not exist', async () => {
      users.findByIdWithRole.mockResolvedValueOnce(makeUser() as never);
      roles.findById.mockResolvedValue(null);
      await expect(service.update('usr_1', { roleId: 'missing' }, SA)).rejects.toThrow(AppException);
    });

    it('applies a partial diff including a role change', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      roles.findById.mockResolvedValue({ id: 'role_2', key: 'VIEWER' } as never);
      users.update.mockResolvedValue({} as never);

      await service.update('usr_1', { firstName: 'Jane', roleId: 'role_2', status: 'ACTIVE' } as never, SA);

      expect(users.update).toHaveBeenCalledWith(
        { id: 'usr_1' },
        { firstName: 'Jane', role: { connect: { id: 'role_2' } }, status: 'ACTIVE' },
      );
    });

    it('refuses to demote or disable the last active admin (409)', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ status: 'ACTIVE', role: { id: 'role_admin', key: 'ADMIN' } }) as never);
      users.countActiveAdmins.mockResolvedValue(1);
      roles.findById.mockResolvedValue({ id: 'role_2', key: 'VIEWER' } as never);
      await expect(service.update('usr_1', { roleId: 'role_2' }, SA)).rejects.toThrow('last active admin');
      await expect(service.update('usr_1', { status: 'DISABLED' } as never, SA)).rejects.toThrow('last active admin');
      expect(users.update).not.toHaveBeenCalled();
    });

    it('lets the last admin edit their own profile fields', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ status: 'ACTIVE', role: { id: 'role_admin', key: 'ADMIN' } }) as never);
      users.countActiveAdmins.mockResolvedValue(1);
      users.update.mockResolvedValue({} as never);
      await service.update('usr_1', { firstName: 'Jane' }, SA);
      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { firstName: 'Jane' });
    });

    it('applies homeTerminalName directly (no re-verification needed)', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      users.update.mockResolvedValue({} as never);
      await service.update('usr_1', { homeTerminalName: 'Dallas, TX' }, SA);
      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, { homeTerminalName: 'Dallas, TX' });
    });

    it('B-84 — an email change does not touch User.email; it issues a re-verification token instead', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ email: 'old@b.com' }) as never);
      users.findByEmail.mockResolvedValue(null);
      users.update.mockResolvedValue({} as never);

      const result = await service.update('usr_1', { email: 'new@b.com' }, SA);

      expect(users.update).toHaveBeenCalledWith({ id: 'usr_1' }, {});
      expect(auth.issueUserEmailVerifyToken).toHaveBeenCalledWith('usr_1', 'new@b.com');
      expect(result.emailVerification).toEqual({ pendingEmail: 'new@b.com', verifyToken: 'verify-token' });
    });

    it('B-84 — throws conflict when the new email is already taken by someone else', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ email: 'old@b.com' }) as never);
      users.findByEmail.mockResolvedValue(makeUser({ id: 'usr_2', email: 'new@b.com' }) as never);
      await expect(service.update('usr_1', { email: 'new@b.com' }, SA)).rejects.toThrow(AppException);
    });

    it('B-84 — no-op when the email in the dto matches the current email', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser({ email: 'same@b.com' }) as never);
      users.update.mockResolvedValue({} as never);
      const result = await service.update('usr_1', { email: 'same@b.com' }, SA);
      expect(auth.issueUserEmailVerifyToken).not.toHaveBeenCalled();
      expect(result.emailVerification).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('throws when user missing', async () => {
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.remove('missing', SA)).rejects.toThrow(AppException);
    });

    it('deletes when found', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      users.delete.mockResolvedValue({} as never);
      await service.remove('usr_1', SA);
      expect(users.delete).toHaveBeenCalledWith({ id: 'usr_1' });
    });
  });

  describe('super admin rules', () => {
    const admin = () => makeUser({ status: 'ACTIVE', role: { id: 'role_admin', key: 'ADMIN' } }) as never;
    const superAdmin = () => makeUser({ status: 'ACTIVE', role: { id: 'role_sa', key: 'SUPER_ADMIN' } }) as never;
    const FORBIDDEN = { code: 'FORBIDDEN', message: 'Only a Super Admin can manage administrators.' };

    it('refuses to invite an ADMIN or SUPER_ADMIN unless the actor is SUPER_ADMIN', async () => {
      for (const key of ['ADMIN', 'SUPER_ADMIN']) {
        roles.findById.mockResolvedValue({ id: 'r', key, name: key } as never);
        await expect(service.invite({ email: 'n@b.com', roleId: 'r' } as never, ADM)).rejects.toMatchObject(FORBIDDEN);
      }
      expect(users.create).not.toHaveBeenCalled();
    });

    it('lets a SUPER_ADMIN invite an ADMIN', async () => {
      roles.findById.mockResolvedValue({ id: 'r', key: 'ADMIN', name: 'Admin' } as never);
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser() as never);
      await service.invite({ email: 'n@b.com', roleId: 'r' } as never, SA);
      expect(users.create).toHaveBeenCalled();
    });

    it('lets an ADMIN invite a non-privileged role', async () => {
      roles.findById.mockResolvedValue({ id: 'r', key: 'DISPATCHER', name: 'Dispatcher' } as never);
      users.findByEmail.mockResolvedValue(null);
      users.create.mockResolvedValue(makeUser() as never);
      await service.invite({ email: 'n@b.com', roleId: 'r' } as never, ADM);
      expect(users.create).toHaveBeenCalled();
    });

    it('forbids a non-SUPER_ADMIN from updating, disabling, deleting or resending an invite to an admin', async () => {
      users.findByIdWithRole.mockResolvedValue(admin());
      await expect(service.update('u', { firstName: 'X' }, ADM)).rejects.toMatchObject(FORBIDDEN);
      await expect(service.update('u', { status: 'DISABLED' } as never, ADM)).rejects.toMatchObject(FORBIDDEN);
      await expect(service.remove('u', ADM)).rejects.toMatchObject(FORBIDDEN);
      await expect(service.resendInvite('u', ADM)).rejects.toMatchObject(FORBIDDEN);
      expect(users.update).not.toHaveBeenCalled();
      expect(users.delete).not.toHaveBeenCalled();
    });

    it('forbids a non-SUPER_ADMIN from promoting someone to ADMIN', async () => {
      users.findByIdWithRole.mockResolvedValue(makeUser() as never);
      roles.findById.mockResolvedValue({ id: 'r', key: 'ADMIN' } as never);
      await expect(service.update('u', { roleId: 'r' }, ADM)).rejects.toMatchObject(FORBIDDEN);
    });

    it('lets a SUPER_ADMIN manage an ADMIN', async () => {
      users.findByIdWithRole.mockResolvedValue(admin());
      users.update.mockResolvedValue({} as never);
      users.delete.mockResolvedValue({} as never);
      await service.update('u', { firstName: 'X' }, SA);
      await service.remove('u', SA);
      expect(users.delete).toHaveBeenCalledWith({ id: 'u' });
    });

    it('refuses to delete, disable or demote the last active SUPER_ADMIN (409)', async () => {
      users.findByIdWithRole.mockResolvedValue(superAdmin());
      users.countActiveSuperAdmins.mockResolvedValue(1);
      roles.findById.mockResolvedValue({ id: 'r', key: 'ADMIN' } as never);
      await expect(service.remove('u', SA)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(service.update('u', { status: 'DISABLED' } as never, SA)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(service.update('u', { roleId: 'r' }, SA)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(users.delete).not.toHaveBeenCalled();
    });

    it('allows demoting a SUPER_ADMIN when another active one exists', async () => {
      users.findByIdWithRole.mockResolvedValue(superAdmin());
      users.countActiveSuperAdmins.mockResolvedValue(2);
      roles.findById.mockResolvedValue({ id: 'r', key: 'ADMIN' } as never);
      users.update.mockResolvedValue({} as never);
      await service.update('u', { roleId: 'r' }, SA);
      expect(users.update).toHaveBeenCalled();
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
