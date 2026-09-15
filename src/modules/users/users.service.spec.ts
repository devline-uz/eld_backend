import { AppException } from '../../common/errors/app.exception';
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
  let users: jest.Mocked<Pick<UsersRepository, 'listWithRoles' | 'findByIdWithRole' | 'findByEmail' | 'create' | 'update' | 'delete'>>;
  let roles: jest.Mocked<Pick<RolesRepository, 'findById'>>;
  let auth: jest.Mocked<Pick<AuthService, 'issueResetToken'>>;
  let service: UsersService;

  beforeEach(() => {
    users = {
      listWithRoles: jest.fn(),
      findByIdWithRole: jest.fn(),
      findByEmail: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    roles = { findById: jest.fn() };
    auth = { issueResetToken: jest.fn().mockReturnValue('invite-token') };
    service = new UsersService(users as unknown as UsersRepository, roles as unknown as RolesRepository, auth as unknown as AuthService);
  });

  it('list strips sensitive fields from every row', async () => {
    users.listWithRoles.mockResolvedValue([makeUser()] as never);
    const result = await service.list();
    expect(result[0]).not.toHaveProperty('passwordHash');
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
});
