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
  let carrier: MockRepo;
  let attachments: MockRepo;
  let mail: MockRepo;
  let loginRecords: MockRepo;

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
      activateInvited: jest.fn(),
      touchLastActive: jest.fn(),
      updatePasswordHash: jest.fn(),
    };
    drivers = {
      findByUsername: jest.fn(),
      findById: jest.fn(),
      findByUsernameOrEmail: jest.fn(),
      updatePasswordHash: jest.fn(),
    };
    sessions = {
      create: jest.fn(),
      findByRefreshHash: jest.fn(),
      findActiveById: jest.fn(),
      listActiveForUser: jest.fn(),
      revoke: jest.fn(),
      revokeAllForUser: jest.fn(),
      revokeAllForUserExcept: jest.fn(),
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
      // MB-21 — TokenService now owns duration parsing for refresh-token DB expiry.
      refreshTtlMs: jest.fn((subjectType: 'user' | 'driver') =>
        subjectType === 'user' ? 30 * 24 * 60 * 60 * 1000 : 90 * 24 * 60 * 60 * 1000,
      ),
    };
    firebase = { enabled: true, verifyIdToken: jest.fn() } as unknown as MockRepo & { enabled: boolean };
    config = { get: jest.fn(), isProduction: false } as unknown as MockRepo & { isProduction: boolean };
    carrier = { get: jest.fn() };
    attachments = { presignKey: jest.fn() };

    (passwordUtil.verifyPassword as jest.Mock).mockResolvedValue(true);
    (passwordUtil.hashPassword as jest.Mock).mockResolvedValue('newhash');
    (hashUtil.randomOpaqueToken as jest.Mock).mockReturnValue('opaque-refresh');

    mail = { send: jest.fn().mockResolvedValue({ delivered: true, reference: 'm1' }) };
    loginRecords = { login: jest.fn().mockResolvedValue(1), logout: jest.fn().mockResolvedValue(1) };
    service = new AuthService(
      users as never,
      drivers as never,
      sessions as never,
      driverSessions as never,
      tokens as never,
      firebase as never,
      config as never,
      carrier as never,
      attachments as never,
      mail as never,
      loginRecords as never,
    );
  });

  describe('loginUser', () => {
    it('throws INVALID_CREDENTIALS when user missing', async () => {
      users.findByEmailWithRole.mockResolvedValue(null);
      await expect(service.loginUser('x@y.com', 'pw', {})).rejects.toThrow(AppException);
    });

    it('B-25 — throws PASSWORD_LOGIN_DISABLED when AUTH_MODE=production, before touching the DB', async () => {
      config.get.mockImplementation((key: string) => (key === 'AUTH_MODE' ? 'production' : undefined));
      await expect(service.loginUser('x@y.com', 'pw', {})).rejects.toMatchObject({ code: 'PASSWORD_LOGIN_DISABLED', status: 403 });
      expect(users.findByEmailWithRole).not.toHaveBeenCalled();
    });

    it('B-25 — AUTH_MODE=dev (default) allows password login to proceed', async () => {
      config.get.mockImplementation((key: string) => (key === 'AUTH_MODE' ? 'dev' : undefined));
      users.findByEmailWithRole.mockResolvedValue(activeUser);
      sessions.create.mockResolvedValue({ id: 's1' });
      await expect(service.loginUser('a@b.com', 'pw', {})).resolves.toBeDefined();
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
      expect(tokens.refreshTtlMs).toHaveBeenCalledWith('user');
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

    it('returns tokens plus driverId on success (MB-9)', async () => {
      drivers.findByUsername.mockResolvedValue(driver);
      driverSessions.create.mockResolvedValue({});
      const result = await service.loginDriver('john', 'pw', { userAgent: 'ua' });
      expect(result).toEqual({
        accessToken: 'daccess',
        refreshToken: 'opaque-refresh',
        tokenType: 'Bearer',
        driverId: 'd1',
      });
    });

    it('D-130: writes the §395 login record only when the driver already holds a unit', async () => {
      drivers.findByUsername.mockResolvedValueOnce({ ...driver, assignedVehicleId: 'veh_1' });
      driverSessions.create.mockResolvedValue({});
      await service.loginDriver('john', 'pw', {});
      expect(loginRecords.login).toHaveBeenCalledWith('d1', 'veh_1', 'AUTH_LOGIN');

      loginRecords.login.mockClear();
      drivers.findByUsername.mockResolvedValueOnce({ ...driver, assignedVehicleId: null });
      await service.loginDriver('john', 'pw', {});
      expect(loginRecords.login).not.toHaveBeenCalled();
    });

    it('uses TokenService.refreshTtlMs(driver) for the session expiry (MB-21)', async () => {
      drivers.findByUsername.mockResolvedValue(driver);
      driverSessions.create.mockResolvedValue({});
      await service.loginDriver('john', 'pw', {});
      expect(tokens.refreshTtlMs).toHaveBeenCalledWith('driver');
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

    it('activates an INVITED user on first sign-in within the invite window', async () => {
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'a@b.com',
        uid: 'guid-1',
      });
      const invited = { ...activeUser, status: 'INVITED', invitedAt: new Date(Date.now() - 60_000) };
      users.findByEmailWithRole.mockResolvedValue(invited);
      users.activateInvited.mockResolvedValue({ ...invited, status: 'ACTIVE' });
      sessions.create.mockResolvedValue({});
      const result = await service.loginGoogle('tok', {});
      expect(users.activateInvited).toHaveBeenCalledWith('u1');
      expect(users.setGoogleUid).toHaveBeenCalledWith('u1', 'guid-1');
      expect(result).toEqual({ accessToken: 'access', refreshToken: 'opaque-refresh', tokenType: 'Bearer' });
    });

    it.each([
      ['older than 7 days', new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)],
      ['with no invitedAt', null],
    ])('rejects an INVITED user %s without activating', async (_label, invitedAt) => {
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'a@b.com',
      });
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, status: 'INVITED', invitedAt });
      await expect(service.loginGoogle('tok', {})).rejects.toMatchObject({ code: 'USER_NOT_INVITED' });
      expect(users.activateInvited).not.toHaveBeenCalled();
      expect(sessions.create).not.toHaveBeenCalled();
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

    it('D-130: a driver logout writes the §395 logout record for the caller; a user logout never does', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', driverId: 'd9', revokedAt: null });
      await service.logout('driver', 'rt', 'd1');
      expect(loginRecords.logout).toHaveBeenCalledWith('d1', 'AUTH_LOGOUT');
      loginRecords.logout.mockClear();
      await service.logout('driver', 'rt');
      expect(loginRecords.logout).toHaveBeenCalledWith('d9', 'AUTH_LOGOUT');
      loginRecords.logout.mockClear();
      sessions.findByRefreshHash.mockResolvedValue(null);
      await service.logout('user', 'rt', 'u1');
      expect(loginRecords.logout).not.toHaveBeenCalled();
    });
  });

  describe('sessions', () => {
    it('listUserSessions delegates to repository and marks the caller session current (B-50)', async () => {
      sessions.listActiveForUser.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      const result = await service.listUserSessions('u1', 's2');
      expect(result).toEqual([
        { id: 's1', current: false },
        { id: 's2', current: true },
      ]);
    });

    it('listUserSessions never leaks refreshHash/userId (B-50)', async () => {
      sessions.listActiveForUser.mockResolvedValue([{ id: 's1' }]);
      const result = await service.listUserSessions('u1');
      expect(result[0]).not.toHaveProperty('refreshHash');
      expect(result[0]).not.toHaveProperty('userId');
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

    it('revokeAllUserSessions delegates to the repository, keeping the current session (B-50 "Sign out everywhere")', async () => {
      sessions.revokeAllForUserExcept.mockResolvedValue(3);
      const revoked = await service.revokeAllUserSessions('u1', 's1');
      expect(sessions.revokeAllForUserExcept).toHaveBeenCalledWith('u1', 's1');
      expect(revoked).toBe(3);
    });
  });

  describe('MR-31 driver forgotPassword / resetPassword', () => {
    const drv = { id: 'd1', email: 'd@x.com', passwordHash: 'h', deletedAt: null };

    it('unknown identifier -> {} and no email (no enumeration)', async () => {
      drivers.findByUsernameOrEmail.mockResolvedValue(null);
      expect(await service.forgotDriverPassword('nobody')).toEqual({});
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('driver without email -> {} and no email', async () => {
      drivers.findByUsernameOrEmail.mockResolvedValue({ ...drv, email: null });
      expect(await service.forgotDriverPassword('john')).toEqual({});
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('emails the code; a mail failure is swallowed (same 200)', async () => {
      tokens.signDriverPasswordResetToken = jest.fn().mockReturnValue('drv-reset');
      drivers.findByUsernameOrEmail.mockResolvedValue(drv);
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = false;
      mail.send.mockRejectedValueOnce(new Error('smtp down'));
      expect(await service.forgotDriverPassword('john')).toEqual({});
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'd@x.com' }));
    });

    it('does not wait for the mail provider (no timing oracle for known identifiers)', async () => {
      tokens.signDriverPasswordResetToken = jest.fn().mockReturnValue('drv-reset');
      drivers.findByUsernameOrEmail.mockResolvedValue(drv);
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = false;
      let delivered = false;
      let release: () => void = () => undefined;
      mail.send.mockImplementationOnce(() => new Promise<void>((r) => { release = () => { delivered = true; r(); }; }));
      expect(await service.forgotDriverPassword('john')).toEqual({});
      expect(delivered).toBe(false);
      release();
    });

    it('reset rotates the hash and revokes all driver sessions', async () => {
      tokens.verifyDriverPasswordResetToken = jest.fn().mockReturnValue({ driverId: 'd1', passwordVersion: sha256('h') });
      drivers.findById.mockResolvedValue(drv);
      (passwordUtil.hashPassword as jest.Mock).mockResolvedValue('new-hash');
      await service.resetDriverPassword('tok', 'newpassword');
      expect(drivers.updatePasswordHash).toHaveBeenCalledWith('d1', 'new-hash');
      expect(driverSessions.revokeAllForDriver).toHaveBeenCalledWith('d1');
    });

    it('reset with a used (stale) token -> TOKEN_INVALID', async () => {
      tokens.verifyDriverPasswordResetToken = jest.fn().mockReturnValue({ driverId: 'd1', passwordVersion: sha256('old') });
      drivers.findById.mockResolvedValue(drv);
      await expect(service.resetDriverPassword('tok', 'newpassword')).rejects.toThrow(AppException);
      expect(drivers.updatePasswordHash).not.toHaveBeenCalled();
    });
  });

  describe('forgotPassword / resetPassword', () => {
    it('forgotPassword returns {} when user unknown (no enumeration)', async () => {
      users.findByEmailWithRole.mockResolvedValue(null);
      const result = await service.forgotPassword('nope@b.com');
      expect(result).toEqual({});
    });

    it('forgotPassword echoes resetToken only when echoOneTimeSecrets is on (DEV_ECHO_SECRETS)', async () => {
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = true;
      users.findByEmailWithRole.mockResolvedValue(activeUser);
      const result = await service.forgotPassword('a@b.com');
      expect(result).toEqual({ resetToken: 'reset-token' });
    });

    it('B-093 — forgotPassword hides resetToken on a non-production host without DEV_ECHO_SECRETS', async () => {
      config.isProduction = false;
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = false;
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

  describe('meProfile (B-34 — GET /auth/me topbar fields)', () => {
    it('enriches a user subject with fullName/email/avatarUrl/carrierName/homeTerminalTimezone', async () => {
      users.findByIdWithRole.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        firstName: 'Sarah',
        lastName: 'Chen',
        avatarKey: 'avatars/u1/x.png',
      });
      carrier.get.mockResolvedValue({ name: 'Universal Logistics Inc.', timezone: 'America/New_York' });
      attachments.presignKey.mockResolvedValue({ url: 'https://minio.local/signed', expiresAt: '2026-01-01T00:00:00.000Z' });

      const result = await service.meProfile({ id: 'u1', type: 'user', role: 'ADMIN', permissions: {} } as never);

      expect(result).toMatchObject({
        id: 'u1',
        type: 'user',
        fullName: 'Sarah Chen',
        email: 'a@b.com',
        avatarUrl: 'https://minio.local/signed',
        carrierName: 'Universal Logistics Inc.',
        homeTerminalTimezone: 'America/New_York',
      });
    });

    it('avatarUrl is null when the user has no avatar (no presign call)', async () => {
      users.findByIdWithRole.mockResolvedValue({ id: 'u1', email: 'a@b.com', firstName: 'Sarah', lastName: 'Chen', avatarKey: null });
      carrier.get.mockResolvedValue({ name: 'Carrier', timezone: 'UTC' });

      const result = await service.meProfile({ id: 'u1', type: 'user' } as never);

      expect((result as unknown as { avatarUrl: unknown }).avatarUrl).toBeNull();
      expect(attachments.presignKey).not.toHaveBeenCalled();
    });

    it('adds the ELD username (and name/email/timezone) for a driver subject (M-31 / D-120)', async () => {
      const driver = { id: 'drv_1', type: 'driver' as const };
      drivers.findById.mockResolvedValue({ id: 'drv_1', username: 'johnsmith', firstName: 'John', lastName: 'Smith', email: null, homeTerminalTimezone: 'America/Chicago' });
      const result = await service.meProfile(driver);
      expect(result).toEqual({ ...driver, username: 'johnsmith', fullName: 'John Smith', email: null, homeTerminalTimezone: 'America/Chicago' });
      expect(users.findByIdWithRole).not.toHaveBeenCalled();
    });

    it('passes a driver subject through unchanged when the row is gone', async () => {
      const driver = { id: 'drv_x', type: 'driver' as const };
      drivers.findById.mockResolvedValue(null);
      expect(await service.meProfile(driver)).toEqual(driver);
    });
  });
});
