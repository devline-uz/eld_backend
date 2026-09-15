import { AppException } from '../../common/errors/app.exception';
import { AuthService } from './auth.service';
import { sha256 } from './lib/hash.util';
import * as passwordUtil from './lib/password.util';
import * as hashUtil from './lib/hash.util';

jest.mock('./lib/password.util');
jest.mock('./lib/hash.util', () => {
  const actual: object = jest.requireActual('./lib/hash.util');
  return { ...actual, randomOpaqueToken: jest.fn() };
});

type MockRepo = Record<string, jest.Mock>;

describe('AuthService', () => {
  let service: AuthService;
  let users: MockRepo;
  let drivers: MockRepo;
  let sessions: MockRepo;
  let driverSessions: MockRepo;
  let tokens: MockRepo;
  let firebase: MockRepo & { enabled: boolean };
  let config: MockRepo & { isProduction: boolean };

  const activeUser = {
    id: 'u1',
    email: 'a@b.com',
    passwordHash: 'hash',
    status: 'ACTIVE',
    googleUid: null,
    role: { key: 'ADMIN', permissions: {} },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    users = {
      findByEmailWithRole: jest.fn(),
      findByIdWithRole: jest.fn(),
      setGoogleUid: jest.fn(),
      touchLastActive: jest.fn(),
      updatePasswordHash: jest.fn(),
    };
    drivers = {
      findByUsername: jest.fn(),
      findById: jest.fn(),
    };
    sessions = {
      create: jest.fn(),
      findByRefreshHash: jest.fn(),
      findActiveById: jest.fn(),
      listActiveForUser: jest.fn(),
      revoke: jest.fn(),
      revokeAllForUser: jest.fn(),
    };
    driverSessions = {
      create: jest.fn(),
      findByRefreshHash: jest.fn(),
      revoke: jest.fn(),
      revokeAllForDriver: jest.fn(),
    };
    tokens = {
      signUserAccessToken: jest.fn().mockReturnValue('access'),
      signDriverAccessToken: jest.fn().mockReturnValue('daccess'),
      signPasswordResetToken: jest.fn().mockReturnValue('reset-token'),
      verifyPasswordResetToken: jest.fn().mockReturnValue({ userId: 'u1', passwordVersion: 'ver' }),
    };
    firebase = { enabled: true, verifyIdToken: jest.fn() } as unknown as MockRepo & { enabled: boolean };
    config = { get: jest.fn(), isProduction: false } as unknown as MockRepo & { isProduction: boolean };

    (passwordUtil.verifyPassword as jest.Mock).mockResolvedValue(true);
    (passwordUtil.hashPassword as jest.Mock).mockResolvedValue('newhash');
    (hashUtil.randomOpaqueToken as jest.Mock).mockReturnValue('opaque-refresh');

    service = new AuthService(
      users as never,
      drivers as never,
      sessions as never,
      driverSessions as never,
      tokens as never,
      firebase as never,
      config as never,
    );
  });

  describe('loginUser', () => {
    it('throws INVALID_CREDENTIALS when user missing', async () => {
      users.findByEmailWithRole.mockResolvedValue(null);
      await expect(service.loginUser('x@y.com', 'pw', {})).rejects.toThrow(AppException);
    });

    it('throws INVALID_CREDENTIALS when no passwordHash', async () => {
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, passwordHash: null });
      await expect(service.loginUser('a@b.com', 'pw', {})).rejects.toThrow(AppException);
    });

    it('throws INVALID_CREDENTIALS when not ACTIVE', async () => {
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, status: 'SUSPENDED' });
      await expect(service.loginUser('a@b.com', 'pw', {})).rejects.toThrow(AppException);
    });

    it('throws INVALID_CREDENTIALS on bad password', async () => {
      users.findByEmailWithRole.mockResolvedValue(activeUser);
      (passwordUtil.verifyPassword as jest.Mock).mockResolvedValue(false);
      await expect(service.loginUser('a@b.com', 'wrong', {})).rejects.toThrow(AppException);
    });

    it('returns tokens on success', async () => {
      users.findByEmailWithRole.mockResolvedValue(activeUser);
      sessions.create.mockResolvedValue({});
      users.touchLastActive.mockResolvedValue({});
      const result = await service.loginUser('a@b.com', 'pw', { ip: '1.1.1.1' });
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'opaque-refresh', tokenType: 'Bearer' });
      expect(users.touchLastActive).toHaveBeenCalledWith('u1');
    });
  });

  describe('loginDriver', () => {
    const driver = { id: 'd1', status: 'ACTIVE', passwordHash: 'h' };

    it('throws when driver missing', async () => {
      drivers.findByUsername.mockResolvedValue(null);
      await expect(service.loginDriver('john', 'pw', {})).rejects.toThrow(AppException);
    });

    it('throws when driver not ACTIVE', async () => {
      drivers.findByUsername.mockResolvedValue({ ...driver, status: 'INACTIVE' });
      await expect(service.loginDriver('john', 'pw', {})).rejects.toThrow(AppException);
    });

    it('throws on bad password', async () => {
      drivers.findByUsername.mockResolvedValue(driver);
      (passwordUtil.verifyPassword as jest.Mock).mockResolvedValue(false);
      await expect(service.loginDriver('john', 'bad', {})).rejects.toThrow(AppException);
    });

    it('returns tokens on success', async () => {
      drivers.findByUsername.mockResolvedValue(driver);
      driverSessions.create.mockResolvedValue({});
      const result = await service.loginDriver('john', 'pw', { userAgent: 'ua' });
      expect(result).toEqual({ accessToken: 'daccess', refreshToken: 'opaque-refresh', tokenType: 'Bearer' });
    });
  });

  describe('loginGoogle', () => {
    it('throws SERVICE_UNAVAILABLE when firebase disabled', async () => {
      firebase.enabled = false;
      await expect(service.loginGoogle('tok', {})).rejects.toThrow(AppException);
    });

    it('throws UNAUTHORIZED when token verification fails', async () => {
      firebase.verifyIdToken.mockRejectedValue(new Error('bad'));
      await expect(service.loginGoogle('tok', {})).rejects.toThrow(AppException);
    });

    it('throws UNAUTHORIZED when not google provider', async () => {
      firebase.verifyIdToken.mockResolvedValue({ firebase: { sign_in_provider: 'password' } });
      await expect(service.loginGoogle('tok', {})).rejects.toThrow(AppException);
    });

    it('throws UNAUTHORIZED on audience mismatch', async () => {
      config.get.mockReturnValue('expected-project');
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        aud: 'other-project',
      });
      await expect(service.loginGoogle('tok', {})).rejects.toThrow(AppException);
    });

    it('throws EMAIL_NOT_VERIFIED when email unverified', async () => {
      config.get.mockReturnValue(undefined);
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: false,
        email: 'a@b.com',
      });
      await expect(service.loginGoogle('tok', {})).rejects.toThrow(AppException);
    });

    it('throws UNAUTHORIZED when no email on token', async () => {
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: undefined,
      });
      await expect(service.loginGoogle('tok', {})).rejects.toThrow(AppException);
    });

    it('throws USER_NOT_INVITED when user unknown', async () => {
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'unknown@b.com',
      });
      users.findByEmailWithRole.mockResolvedValue(null);
      await expect(service.loginGoogle('tok', {})).rejects.toThrow(AppException);
    });

    it('throws USER_NOT_INVITED when user inactive', async () => {
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'a@b.com',
      });
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, status: 'SUSPENDED' });
      await expect(service.loginGoogle('tok', {})).rejects.toThrow(AppException);
    });

    it('sets googleUid when missing and logs in', async () => {
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'a@b.com',
        uid: 'guid-1',
      });
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, googleUid: null });
      users.setGoogleUid.mockResolvedValue({});
      sessions.create.mockResolvedValue({});
      const result = await service.loginGoogle('tok', {});
      expect(users.setGoogleUid).toHaveBeenCalledWith('u1', 'guid-1');
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'opaque-refresh', tokenType: 'Bearer' });
    });

    it('does not touch googleUid when already set', async () => {
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'a@b.com',
        uid: 'guid-1',
      });
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, googleUid: 'already' });
      sessions.create.mockResolvedValue({});
      await service.loginGoogle('tok', {});
      expect(users.setGoogleUid).not.toHaveBeenCalled();
    });
  });

  describe('refresh — user', () => {
    it('throws TOKEN_INVALID when session not found', async () => {
      sessions.findByRefreshHash.mockResolvedValue(null);
      await expect(service.refresh('rt', 'user', {})).rejects.toThrow(AppException);
    });

    it('revokes all sessions and throws REFRESH_TOKEN_REUSED when session already revoked', async () => {
      sessions.findByRefreshHash.mockResolvedValue({ id: 's1', userId: 'u1', revokedAt: new Date() });
      sessions.revokeAllForUser.mockResolvedValue(undefined);
      await expect(service.refresh('rt', 'user', {})).rejects.toThrow(AppException);
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u1');
    });

    it('throws TOKEN_EXPIRED when session expired', async () => {
      sessions.findByRefreshHash.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.refresh('rt', 'user', {})).rejects.toThrow(AppException);
    });

    it('throws UNAUTHORIZED when user no longer exists/active', async () => {
      sessions.findByRefreshHash.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100000),
      });
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.refresh('rt', 'user', {})).rejects.toThrow(AppException);
    });

    it('rotates and returns a new token pair', async () => {
      sessions.findByRefreshHash.mockResolvedValue({
        id: 's1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100000),
        userAgent: 'old-ua',
        ip: '9.9.9.9',
        deviceLabel: 'phone',
      });
      users.findByIdWithRole.mockResolvedValue(activeUser);
      sessions.revoke.mockResolvedValue({});
      sessions.create.mockResolvedValue({});
      const result = await service.refresh('rt', 'user', {});
      expect(result.accessToken).toBe('access');
      expect(sessions.revoke).toHaveBeenCalledWith('s1');
    });
  });

  describe('refresh — driver', () => {
    it('throws TOKEN_INVALID when session not found', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue(null);
      await expect(service.refresh('rt', 'driver', {})).rejects.toThrow(AppException);
    });

    it('revokes all driver sessions and throws REFRESH_TOKEN_REUSED', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', driverId: 'd1', revokedAt: new Date() });
      await expect(service.refresh('rt', 'driver', {})).rejects.toThrow(AppException);
      expect(driverSessions.revokeAllForDriver).toHaveBeenCalledWith('d1');
    });

    it('throws TOKEN_EXPIRED when driver session expired', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({
        id: 's1',
        driverId: 'd1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.refresh('rt', 'driver', {})).rejects.toThrow(AppException);
    });

    it('throws UNAUTHORIZED when driver no longer exists/active', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({
        id: 's1',
        driverId: 'd1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100000),
      });
      drivers.findById.mockResolvedValue({ status: 'INACTIVE' });
      await expect(service.refresh('rt', 'driver', {})).rejects.toThrow(AppException);
    });

    it('rotates and returns a new driver token pair', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({
        id: 's1',
        driverId: 'd1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 100000),
        userAgent: 'ua',
        ip: '1.2.3.4',
        deviceLabel: 'tablet',
        appVersion: '1.0',
      });
      drivers.findById.mockResolvedValue({ id: 'd1', status: 'ACTIVE' });
      driverSessions.revoke.mockResolvedValue({});
      driverSessions.create.mockResolvedValue({});
      const result = await service.refresh('rt', 'driver', {});
      expect(result.accessToken).toBe('daccess');
    });
  });

  describe('logout', () => {
    it('revokes an active user session', async () => {
      sessions.findByRefreshHash.mockResolvedValue({ id: 's1', revokedAt: null });
      sessions.revoke.mockResolvedValue({});
      await service.logout('user', 'rt');
      expect(sessions.revoke).toHaveBeenCalledWith('s1');
    });

    it('no-ops when user session already revoked or missing', async () => {
      sessions.findByRefreshHash.mockResolvedValue(null);
      await service.logout('user', 'rt');
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('revokes an active driver session', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', revokedAt: null });
      driverSessions.revoke.mockResolvedValue({});
      await service.logout('driver', 'rt');
      expect(driverSessions.revoke).toHaveBeenCalledWith('s1');
    });

    it('no-ops when driver session already revoked', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', revokedAt: new Date() });
      await service.logout('driver', 'rt');
      expect(driverSessions.revoke).not.toHaveBeenCalled();
    });
  });

  describe('sessions', () => {
    it('listUserSessions delegates to repository', async () => {
      sessions.listActiveForUser.mockResolvedValue([{ id: 's1' }]);
      const result = await service.listUserSessions('u1');
      expect(result).toEqual([{ id: 's1' }]);
    });

    it('revokeUserSession throws notFound when session missing', async () => {
      sessions.findActiveById.mockResolvedValue(null);
      await expect(service.revokeUserSession('u1', 's1')).rejects.toThrow(AppException);
    });

    it('revokeUserSession revokes when found', async () => {
      sessions.findActiveById.mockResolvedValue({ id: 's1' });
      sessions.revoke.mockResolvedValue({});
      await service.revokeUserSession('u1', 's1');
      expect(sessions.revoke).toHaveBeenCalledWith('s1');
    });
  });

  describe('forgotPassword / resetPassword', () => {
    it('forgotPassword returns {} when user unknown (no enumeration)', async () => {
      users.findByEmailWithRole.mockResolvedValue(null);
      const result = await service.forgotPassword('nope@b.com');
      expect(result).toEqual({});
    });

    it('forgotPassword returns resetToken outside production', async () => {
      config.isProduction = false;
      users.findByEmailWithRole.mockResolvedValue(activeUser);
      const result = await service.forgotPassword('a@b.com');
      expect(result).toEqual({ resetToken: 'reset-token' });
    });

    it('forgotPassword hides resetToken in production', async () => {
      config.isProduction = true;
      users.findByEmailWithRole.mockResolvedValue(activeUser);
      const result = await service.forgotPassword('a@b.com');
      expect(result).toEqual({});
    });

    it('issueResetToken signs with hash of empty string when no password', () => {
      const token = service.issueResetToken('u1', null);
      expect(token).toBe('reset-token');
      expect(tokens.signPasswordResetToken).toHaveBeenCalledWith('u1', expect.any(String));
    });

    it('resetPassword throws TOKEN_INVALID when user missing', async () => {
      users.findByIdWithRole.mockResolvedValue(null);
      await expect(service.resetPassword('tok', 'newpw')).rejects.toThrow(AppException);
    });

    it('resetPassword throws TOKEN_INVALID when password version mismatch', async () => {
      users.findByIdWithRole.mockResolvedValue({ ...activeUser, passwordHash: 'different' });
      tokens.verifyPasswordResetToken.mockReturnValue({ userId: 'u1', passwordVersion: 'stale-version' });
      await expect(service.resetPassword('tok', 'newpw')).rejects.toThrow(AppException);
    });

    it('resetPassword updates hash and revokes all sessions on success', async () => {
      users.findByIdWithRole.mockResolvedValue(activeUser);
      tokens.verifyPasswordResetToken.mockReturnValue({ userId: 'u1', passwordVersion: sha256('hash') });
      users.updatePasswordHash.mockResolvedValue({});
      sessions.revokeAllForUser.mockResolvedValue(undefined);
      await service.resetPassword('tok', 'newpw');
      expect(users.updatePasswordHash).toHaveBeenCalledWith('u1', 'newhash');
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u1');
    });
  });

  describe('meta', () => {
    it('extracts ip and user-agent from the request', () => {
      const req = { ip: '5.5.5.5', headers: { 'user-agent': 'Chrome' } };
      expect(AuthService.meta(req as never)).toEqual({ ip: '5.5.5.5', userAgent: 'Chrome' });
    });
  });
});
