import { AppException } from '../../common/errors/app.exception';
import { fakeUserEmailTable } from '../../../test/helpers/fake-user-email-table';
import { AuthService } from './auth.service';
import { UserAuthRepository } from './repositories/user-auth.repository';
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
  let resetCodes: MockRepo;
  let graceStore: MockRepo & { windowSeconds: number };
  let principals: MockRepo;
  let events: MockRepo;

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
      recordFailedLogin: jest.fn().mockResolvedValue(false),
      clearFailedLogins: jest.fn().mockResolvedValue(undefined),
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
      rotate: jest.fn(),
      revokeFamily: jest.fn(),
      revokeAllForUser: jest.fn(),
      revokeAllForUserExcept: jest.fn(),
    };
    driverSessions = {
      create: jest.fn(),
      findByRefreshHash: jest.fn(),
      revoke: jest.fn(),
      rotate: jest.fn(),
      revokeFamily: jest.fn(),
      revokeAllForDriver: jest.fn(),
      findById: jest.fn(),
      countActiveInFamily: jest.fn(),
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
    resetCodes = {
      upsert: jest.fn().mockResolvedValue({}),
      find: jest.fn(),
      incrementAttempts: jest.fn(),
      claimAttempt: jest.fn().mockResolvedValue(true),
      consume: jest.fn().mockResolvedValue(true),
      isLocked: jest.fn().mockResolvedValue(false),
      recordFailure: jest.fn().mockResolvedValue(false),
      notifyAdminsOfResetRequest: jest.fn().mockResolvedValue(2),
    };
    graceStore = { windowSeconds: 60, put: jest.fn().mockResolvedValue(undefined), get: jest.fn() } as never;
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    principals = { invalidateUser: jest.fn().mockResolvedValue(undefined), invalidateDriver: jest.fn().mockResolvedValue(undefined) };
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
      resetCodes as never,
      graceStore as never,
      principals as never,
      events as never,
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
      expect(users.clearFailedLogins).toHaveBeenCalledWith('u1');
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'LOGIN', objectId: 'u1', actorId: 'u1', ip: '1.1.1.1' }));
    });

    describe('CODE-082 lockout', () => {
      it('counts a wrong password toward the lock and audits the lock when it trips', async () => {
        users.findByEmailWithRole.mockResolvedValue(activeUser);
        (passwordUtil.verifyPassword as jest.Mock).mockResolvedValue(false);
        users.recordFailedLogin.mockResolvedValue(true);
        await expect(service.loginUser('a@b.com', 'wrong', {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
        expect(users.recordFailedLogin).toHaveBeenCalledWith('u1', 10, expect.any(Date));
        expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'LOGIN_LOCKED', objectId: 'u1' }));
      });

      it('a wrong password on a locked account is still a plain 401 (no enumeration) and does not extend the lock', async () => {
        users.findByEmailWithRole.mockResolvedValue({ ...activeUser, lockedUntil: new Date(Date.now() + 60_000) });
        (passwordUtil.verifyPassword as jest.Mock).mockResolvedValue(false);
        await expect(service.loginUser('a@b.com', 'wrong', {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
        expect(users.recordFailedLogin).not.toHaveBeenCalled();
      });

      it('the right password on a locked account gets 423 ACCOUNT_LOCKED with retryAfterSec, no tokens', async () => {
        users.findByEmailWithRole.mockResolvedValue({ ...activeUser, lockedUntil: new Date(Date.now() + 90_000) });
        await expect(service.loginUser('a@b.com', 'pw', {})).rejects.toMatchObject({
          code: 'ACCOUNT_LOCKED',
          status: 423,
          details: { retryAfterSec: expect.any(Number) as number },
        });
        expect(sessions.create).not.toHaveBeenCalled();
      });

      it('an expired lock no longer blocks', async () => {
        users.findByEmailWithRole.mockResolvedValue({ ...activeUser, lockedUntil: new Date(Date.now() - 1_000) });
        sessions.create.mockResolvedValue({});
        await expect(service.loginUser('a@b.com', 'pw', {})).resolves.toBeDefined();
      });
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

    it('D-155: the driver access token carries the new session id (sid)', async () => {
      drivers.findByUsername.mockResolvedValue(driver);
      driverSessions.create.mockResolvedValue({ id: 'ds1' });
      await service.loginDriver('john', 'pw', {});
      expect(tokens.signDriverAccessToken).toHaveBeenCalledWith({ id: 'd1', sessionId: 'ds1' });
    });

    it('D-155: resolveDriverSessionFamily maps sid -> family; foreign/unknown/absent sid -> null; revoked row in a live family is not revoked', async () => {
      driverSessions.findById.mockResolvedValue({ id: 's2', driverId: 'd1', familyId: 'fam', revokedAt: new Date() });
      driverSessions.countActiveInFamily.mockResolvedValue(1);
      await expect(service.resolveDriverSessionFamily('d1', 's2')).resolves.toEqual({ familyId: 'fam', revoked: false });
      driverSessions.countActiveInFamily.mockResolvedValue(0);
      await expect(service.resolveDriverSessionFamily('d1', 's2')).resolves.toEqual({ familyId: 'fam', revoked: true });
      driverSessions.findById.mockResolvedValue({ id: 's3', driverId: 'd1', familyId: null, revokedAt: null });
      await expect(service.resolveDriverSessionFamily('d1', 's3')).resolves.toEqual({ familyId: 's3', revoked: false });
      driverSessions.findById.mockResolvedValue({ id: 's4', driverId: 'other', familyId: 'f', revokedAt: null });
      await expect(service.resolveDriverSessionFamily('d1', 's4')).resolves.toBeNull();
      await expect(service.resolveDriverSessionFamily('d1', undefined)).resolves.toBeNull();
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

    it('CODE-082: refuses a Google identity other than the one linked to the user, and audits it', async () => {
      config.get.mockReturnValue(undefined);
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'a@b.com',
        uid: 'guid-other',
      });
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, googleUid: 'guid-1' });
      await expect(service.loginGoogle('tok', {})).rejects.toMatchObject({ status: 401 });
      expect(sessions.create).not.toHaveBeenCalled();
      expect(users.setGoogleUid).not.toHaveBeenCalled();
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'LOGIN_REJECTED_GOOGLE_MISMATCH' }));
    });

    it('CODE-082: the linked Google identity signs in', async () => {
      config.get.mockReturnValue(undefined);
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'a@b.com',
        uid: 'guid-1',
      });
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, googleUid: 'guid-1' });
      sessions.create.mockResolvedValue({});
      await expect(service.loginGoogle('tok', {})).resolves.toMatchObject({ accessToken: 'access' });
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
        uid: 'already',
      });
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, googleUid: 'already' });
      sessions.create.mockResolvedValue({});
      await service.loginGoogle('tok', {});
      expect(users.setGoogleUid).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ['user'],
    ['driver'],
  ] as const)('refresh — %s (MG-32 family revoke + grace window)', (subject) => {
    const repo = () => (subject === 'user' ? sessions : driverSessions);
    const rows = () => ({ ...(subject === 'user' ? { userId: 'u1' } : { driverId: 'd1' }) });
    const live = (over: object = {}) => ({
      id: 's1',
      ...rows(),
      revokedAt: null,
      rotatedAt: null,
      familyId: 'fam1',
      expiresAt: new Date(Date.now() + 100000),
      userAgent: 'ua',
      ip: '1.2.3.4',
      deviceLabel: 'phone',
      appVersion: '1.0',
      ...over,
    });
    const okSubject = () => {
      users.findByIdWithRole.mockResolvedValue(activeUser);
      drivers.findById.mockResolvedValue({ id: 'd1', status: 'ACTIVE' });
    };
    const accessName = subject === 'user' ? 'access' : 'daccess';

    it('throws TOKEN_INVALID when session not found', async () => {
      repo().findByRefreshHash.mockResolvedValue(null);
      await expect(service.refresh('rt', subject, {})).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    });

    it('throws TOKEN_EXPIRED when session expired', async () => {
      repo().findByRefreshHash.mockResolvedValue(live({ expiresAt: new Date(Date.now() - 1000) }));
      await expect(service.refresh('rt', subject, {})).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    });

    it('throws UNAUTHORIZED when subject no longer exists/active', async () => {
      repo().findByRefreshHash.mockResolvedValue(live());
      users.findByIdWithRole.mockResolvedValue(null);
      drivers.findById.mockResolvedValue({ status: 'INACTIVE' });
      // Driver cut-off: an inactive driver gets DRIVER_DISABLED and loses every app session.
      await expect(service.refresh('rt', subject, {})).rejects.toMatchObject({ code: subject === 'user' ? 'UNAUTHORIZED' : 'DRIVER_DISABLED', status: 401 });
      if (subject === 'driver') {
        expect(driverSessions.revokeAllForDriver).toHaveBeenCalledWith('d1');
        expect(principals.invalidateDriver).toHaveBeenCalledWith('d1');
      }
    });

    if (subject === 'driver') {
      it('refuses a deleted driver with DRIVER_DISABLED and revokes their sessions', async () => {
        repo().findByRefreshHash.mockResolvedValue(live());
        drivers.findById.mockResolvedValue({ id: 'd1', status: 'ACTIVE', deletedAt: new Date() });
        await expect(service.refresh('rt', subject, {})).rejects.toMatchObject({ code: 'DRIVER_DISABLED' });
        expect(driverSessions.revokeAllForDriver).toHaveBeenCalledWith('d1');
        expect(repo().rotate).not.toHaveBeenCalled();
      });
    }

    it('rotates inside the same family, returns the pair and parks it in the grace store', async () => {
      repo().findByRefreshHash.mockResolvedValue(live());
      okSubject();
      repo().rotate.mockResolvedValue({ id: 's2' });
      const result = await service.refresh('rt', subject, {});
      expect(result).toEqual({ accessToken: accessName, refreshToken: 'opaque-refresh', tokenType: 'Bearer' });
      expect(repo().rotate).toHaveBeenCalledWith('s1', expect.objectContaining({ familyId: 'fam1', refreshHash: sha256('opaque-refresh') }));
      expect(graceStore.put).toHaveBeenCalledWith('rt', sha256('rt'), { accessToken: accessName, refreshToken: 'opaque-refresh' });
    });

    it('a legacy row without familyId starts its family at its own id', async () => {
      repo().findByRefreshHash.mockResolvedValue(live({ familyId: null }));
      okSubject();
      repo().rotate.mockResolvedValue({ id: 's2' });
      await service.refresh('rt', subject, {});
      expect(repo().rotate).toHaveBeenCalledWith('s1', expect.objectContaining({ familyId: 's1' }));
    });

    it('replay of a token rotated 10 s ago returns the SAME pair, no revoke', async () => {
      repo().findByRefreshHash.mockResolvedValue(live({ revokedAt: new Date(), rotatedAt: new Date(Date.now() - 10_000) }));
      graceStore.get.mockResolvedValue({ accessToken: 'A2', refreshToken: 'R2' });
      await expect(service.refresh('rt', subject, {})).resolves.toEqual({ accessToken: 'A2', refreshToken: 'R2', tokenType: 'Bearer' });
      expect(repo().revokeFamily).not.toHaveBeenCalled();
      expect(repo().rotate).not.toHaveBeenCalled();
    });

    it('reuse after the window revokes ONLY that family (never every session of the subject)', async () => {
      repo().findByRefreshHash.mockResolvedValue(live({ revokedAt: new Date(), rotatedAt: new Date(Date.now() - 61_000) }));
      await expect(service.refresh('rt', subject, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED', status: 401 });
      expect(repo().revokeFamily).toHaveBeenCalledWith('fam1');
      // CODE-012 — the subject's cached live access is evicted on every replica.
      if (subject === 'user') expect(principals.invalidateUser).toHaveBeenCalledWith('u1');
      else expect(principals.invalidateDriver).toHaveBeenCalledWith('d1');
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(driverSessions.revokeAllForDriver).not.toHaveBeenCalled();
      expect(graceStore.get).not.toHaveBeenCalled();
    });

    it('window 0 disables the grace: an immediate replay is reuse', async () => {
      graceStore.windowSeconds = 0;
      repo().findByRefreshHash.mockResolvedValue(live({ revokedAt: new Date(), rotatedAt: new Date() }));
      await expect(service.refresh('rt', subject, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
      expect(repo().revokeFamily).toHaveBeenCalledWith('fam1');
    });

    it('a token revoked by logout/admin/reset (not rotated) is TOKEN_INVALID and revokes nothing', async () => {
      repo().findByRefreshHash.mockResolvedValue(live({ revokedAt: new Date(), rotatedAt: null }));
      await expect(service.refresh('rt', subject, {})).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
      expect(repo().revokeFamily).not.toHaveBeenCalled();
    });

    it('legacy revoked row (no familyId) outside the window revokes nothing else', async () => {
      repo().findByRefreshHash.mockResolvedValue(live({ familyId: null, revokedAt: new Date(), rotatedAt: new Date(Date.now() - 120_000) }));
      await expect(service.refresh('rt', subject, {})).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
      expect(repo().revokeFamily).not.toHaveBeenCalled();
    });

    it('inside the window but pair unavailable: 401 REUSED without a family revoke', async () => {
      jest.useFakeTimers({ advanceTimers: true });
      try {
        repo().findByRefreshHash.mockResolvedValue(live({ revokedAt: new Date(), rotatedAt: new Date() }));
        graceStore.get.mockResolvedValue(null);
        const p = service.refresh('rt', subject, {});
        const assertion = expect(p).rejects.toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
        await jest.advanceTimersByTimeAsync(3000);
        await assertion;
        expect(repo().revokeFamily).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('two PARALLEL refreshes with the same token both succeed with the same pair; one rotation', async () => {
      // Stateful fake: atomic claim like the DB transaction, pair parked like Redis.
      const row = live();
      const store = new Map<string, { accessToken: string; refreshToken: string }>();
      repo().findByRefreshHash.mockImplementation(async () => ({ ...row }));
      repo().rotate.mockImplementation(async () => {
        await Promise.resolve();
        if (row.revokedAt) return null;
        row.revokedAt = new Date() as never;
        row.rotatedAt = new Date() as never;
        return { id: 's2' };
      });
      graceStore.put.mockImplementation(async (_t: string, h: string, pair: never) => {
        await new Promise((r) => setTimeout(r, 20));
        store.set(h, pair);
      });
      graceStore.get.mockImplementation(async (_t: string, h: string) => store.get(h) ?? null);
      okSubject();
      const [a, b] = await Promise.all([service.refresh('rt', subject, {}), service.refresh('rt', subject, {})]);
      expect(a).toEqual(b);
      expect(a.refreshToken).toBe('opaque-refresh');
      expect(repo().rotate).toHaveBeenCalledTimes(2);
      expect(repo().revokeFamily).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the caller\'s own active user session and audits it (CODE-079, CODE-083)', async () => {
      sessions.findByRefreshHash.mockResolvedValue({ id: 's1', userId: 'u1', revokedAt: null });
      sessions.revoke.mockResolvedValue({});
      await service.logout('user', 'rt', 'u1', { ip: '1.2.3.4' });
      expect(sessions.revoke).toHaveBeenCalledWith('s1');
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'LOGOUT', objectType: 'User', objectId: 'u1', ip: '1.2.3.4' }));
    });

    it('CODE-079: ignores another user\'s refresh token (no revoke, no audit)', async () => {
      sessions.findByRefreshHash.mockResolvedValue({ id: 's1', userId: 'someone-else', revokedAt: null });
      await service.logout('user', 'rt', 'u1');
      expect(sessions.revoke).not.toHaveBeenCalled();
      expect(principals.invalidateUser).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('no-ops when user session already revoked or missing', async () => {
      sessions.findByRefreshHash.mockResolvedValue(null);
      await service.logout('user', 'rt', 'u1');
      expect(sessions.revoke).not.toHaveBeenCalled();
    });

    it('revokes the caller\'s own active driver session', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', driverId: 'd1', revokedAt: null });
      driverSessions.revoke.mockResolvedValue({});
      await service.logout('driver', 'rt', 'd1');
      expect(driverSessions.revoke).toHaveBeenCalledWith('s1');
    });

    it('CODE-079: a driver cannot revoke another driver\'s session', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', driverId: 'd9', revokedAt: null });
      await service.logout('driver', 'rt', 'd1');
      expect(driverSessions.revoke).not.toHaveBeenCalled();
    });

    it('no-ops when driver session already revoked', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', driverId: 'd1', revokedAt: new Date() });
      await service.logout('driver', 'rt', 'd1');
      expect(driverSessions.revoke).not.toHaveBeenCalled();
    });

    it('D-155: logout with the old refresh token after a co-driver switch is a harmless 200 — nothing revoked twice, only the idempotent logout record call', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', driverId: 'd1', revokedAt: new Date() });
      await expect(service.logout('driver', 'old-rt', 'd1')).resolves.toBeUndefined();
      expect(driverSessions.revoke).not.toHaveBeenCalled();
      expect(loginRecords.logout).toHaveBeenCalledWith('d1', 'AUTH_LOGOUT');
    });

    it('D-130: a driver logout writes the §395 logout record for the caller; a user logout never does', async () => {
      driverSessions.findByRefreshHash.mockResolvedValue({ id: 's1', driverId: 'd9', revokedAt: null });
      await service.logout('driver', 'rt', 'd1');
      expect(loginRecords.logout).toHaveBeenCalledWith('d1', 'AUTH_LOGOUT');
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
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'SESSION_REVOKED', objectId: 'u1', after: { sessionId: 's1' } }));
    });

    it('revokeAllUserSessions delegates to the repository, keeping the current session (B-50 "Sign out everywhere")', async () => {
      sessions.revokeAllForUserExcept.mockResolvedValue(3);
      const revoked = await service.revokeAllUserSessions('u1', 's1');
      expect(sessions.revokeAllForUserExcept).toHaveBeenCalledWith('u1', 's1');
      expect(revoked).toBe(3);
      expect(events.publish).toHaveBeenCalledWith('audit.record', expect.objectContaining({ action: 'SESSIONS_REVOKED', after: { revoked: 3, keptSessionId: 's1' } }));
    });

    it('CODE-083: nothing revoked -> no audit row', async () => {
      sessions.revokeAllForUserExcept.mockResolvedValue(0);
      await service.revokeAllUserSessions('u1', 's1');
      expect(events.publish).not.toHaveBeenCalled();
    });
  });

  describe('MR-31 driver forgotPassword / resetPassword', () => {
    const drv = { id: 'd1', email: 'd@x.com', passwordHash: 'h', deletedAt: null };

    it('unknown identifier -> {} and no email (no enumeration)', async () => {
      drivers.findByUsernameOrEmail.mockResolvedValue(null);
      expect(await service.forgotDriverPassword('nobody')).toEqual({});
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('driver without email -> {}, no email, no code, admins notified (MB-16)', async () => {
      const noEmail = { ...drv, email: null, firstName: 'J', lastName: 'S', username: 'john' };
      drivers.findByUsernameOrEmail.mockResolvedValue(noEmail);
      expect(await service.forgotDriverPassword('john')).toEqual({});
      await new Promise((r) => setImmediate(r));
      expect(mail.send).not.toHaveBeenCalled();
      expect(resetCodes.upsert).not.toHaveBeenCalled();
      expect(resetCodes.notifyAdminsOfResetRequest).toHaveBeenCalledWith(noEmail, expect.any(Date), 'NO_EMAIL');
    });

    it('driver email change hold — no code is mailed to a just-changed address; admins are notified instead', async () => {
      config.get.mockImplementation((key: string) => (key === 'DRIVER_EMAIL_CHANGE_HOLD_HOURS' ? 48 : undefined));
      const changed = { ...drv, firstName: 'J', lastName: 'S', username: 'john', emailChangedAt: new Date(Date.now() - 3_600_000) };
      drivers.findByUsernameOrEmail.mockResolvedValue(changed);
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = true;
      expect(await service.forgotDriverPassword('d@x.com')).toEqual({});
      await new Promise((r) => setImmediate(r));
      expect(mail.send).not.toHaveBeenCalled();
      expect(resetCodes.upsert).not.toHaveBeenCalled();
      expect(resetCodes.notifyAdminsOfResetRequest).toHaveBeenCalledWith(changed, expect.any(Date), 'EMAIL_CHANGE_HOLD');
    });

    it('driver email change hold — once the window has passed the code is mailed again', async () => {
      config.get.mockImplementation((key: string) => (key === 'DRIVER_EMAIL_CHANGE_HOLD_HOURS' ? 48 : undefined));
      tokens.signDriverPasswordResetToken = jest.fn().mockReturnValue('drv-reset');
      drivers.findByUsernameOrEmail.mockResolvedValue({ ...drv, emailChangedAt: new Date(Date.now() - 49 * 3_600_000) });
      await service.forgotDriverPassword('john');
      await new Promise((r) => setImmediate(r));
      expect(resetCodes.notifyAdminsOfResetRequest).not.toHaveBeenCalled();
      expect(mail.send).toHaveBeenCalledTimes(1);
    });

    it('admin notification failure is swallowed (still 200 shape)', async () => {
      drivers.findByUsernameOrEmail.mockResolvedValue({ ...drv, email: null });
      resetCodes.notifyAdminsOfResetRequest.mockRejectedValueOnce(new Error('db'));
      expect(await service.forgotDriverPassword('john')).toEqual({});
      await new Promise((r) => setImmediate(r));
    });

    it('stores only a salted hash of a 6-digit code and emails the code with its expiry', async () => {
      tokens.signDriverPasswordResetToken = jest.fn().mockReturnValue('drv-reset');
      drivers.findByUsernameOrEmail.mockResolvedValue(drv);
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = true;
      const res = await service.forgotDriverPassword('john');
      await new Promise((r) => setImmediate(r));
      expect(res.resetCode).toMatch(/^\d{6}$/);
      const [driverId, salt, hash, expiresAt] = resetCodes.upsert.mock.calls[0] as [string, string, string, Date];
      expect(driverId).toBe('d1');
      expect(hash).toBe(sha256(`${salt}:${res.resetCode}`));
      expect(hash).not.toContain(res.resetCode as string);
      expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      const text = ((mail.send.mock.calls as [{ text: string }][])[0][0]).text;
      expect(text).toContain(res.resetCode);
      expect(text).toContain('15 minutes');
    });

    describe('reset with code (MB-17)', () => {
      const row = (over: object = {}) => ({
        driverId: 'd1', salt: 's', codeHash: sha256('s:123456'), attempts: 0, expiresAt: new Date(Date.now() + 60_000), ...over,
      });
      beforeEach(() => drivers.findByUsernameOrEmail.mockResolvedValue(drv));

      it('correct code -> password rotated, sessions revoked, code consumed', async () => {
        resetCodes.find.mockResolvedValue(row());
        await service.resetDriverPasswordWithCode('john', '123456', 'newpassword');
        expect(drivers.updatePasswordHash).toHaveBeenCalledWith('d1', 'newhash');
        expect(driverSessions.revokeAllForDriver).toHaveBeenCalledWith('d1');
        expect(resetCodes.consume).toHaveBeenCalledWith('d1');
      });

      it('wrong code -> 401, attempt counted, password untouched', async () => {
        resetCodes.find.mockResolvedValue(row());
        await expect(service.resetDriverPasswordWithCode('john', '000000', 'newpassword')).rejects.toMatchObject({ status: 401 });
        expect(resetCodes.claimAttempt).toHaveBeenCalledWith('d1', sha256('s:123456'), 5, expect.any(Date));
        expect(resetCodes.consume).not.toHaveBeenCalled();
        expect(drivers.updatePasswordHash).not.toHaveBeenCalled();
      });

      it('5th wrong attempt invalidates the code', async () => {
        resetCodes.find.mockResolvedValue(row({ attempts: 4 }));
        await expect(service.resetDriverPasswordWithCode('john', '000000', 'newpassword')).rejects.toThrow(AppException);
        expect(resetCodes.consume).toHaveBeenCalledWith('d1');
      });

      it('exhausted code rejects even the correct code', async () => {
        resetCodes.find.mockResolvedValue(row({ attempts: 5 }));
        await expect(service.resetDriverPasswordWithCode('john', '123456', 'newpassword')).rejects.toThrow(AppException);
        expect(drivers.updatePasswordHash).not.toHaveBeenCalled();
      });

      it('expired code -> 401', async () => {
        resetCodes.find.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1) }));
        await expect(service.resetDriverPasswordWithCode('john', '123456', 'newpassword')).rejects.toThrow(AppException);
        expect(drivers.updatePasswordHash).not.toHaveBeenCalled();
      });

      it('no code row / unknown driver -> same 401', async () => {
        resetCodes.find.mockResolvedValue(null);
        await expect(service.resetDriverPasswordWithCode('john', '123456', 'newpassword')).rejects.toMatchObject({ status: 401 });
        drivers.findByUsernameOrEmail.mockResolvedValue(null);
        await expect(service.resetDriverPasswordWithCode('x', '123456', 'newpassword')).rejects.toMatchObject({ status: 401 });
      });

      it('B-158: no attempt left to claim (parallel guesses spent it) -> 401 even for the correct code', async () => {
        resetCodes.find.mockResolvedValue(row({ attempts: 2 }));
        resetCodes.claimAttempt.mockResolvedValueOnce(false);
        await expect(service.resetDriverPasswordWithCode('john', '123456', 'newpassword')).rejects.toMatchObject({ status: 401 });
        expect(resetCodes.consume).not.toHaveBeenCalled();
        expect(drivers.updatePasswordHash).not.toHaveBeenCalled();
      });

      it('B-158: inside the issuance cooldown no code is stored and no mail is sent', async () => {
        tokens.signDriverPasswordResetToken = jest.fn().mockReturnValue('drv-reset');
        drivers.findByUsernameOrEmail.mockResolvedValue(drv);
        resetCodes.upsert.mockResolvedValueOnce(null);
        expect(await service.forgotDriverPassword('john')).toEqual(expect.any(Object));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(mail.send).not.toHaveBeenCalled();
      });

      it('B-160: a wrong code is counted against the per-driver 24 h failure budget', async () => {
        resetCodes.find.mockResolvedValue(row());
        await expect(service.resetDriverPasswordWithCode('john', '000000', 'newpassword')).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
        expect(resetCodes.recordFailure).toHaveBeenCalledWith('d1', expect.any(Date));
      });

      it('B-160: a locked driver gets the same generic 401 even with the correct code; nothing is compared', async () => {
        resetCodes.isLocked.mockResolvedValueOnce(true);
        resetCodes.find.mockResolvedValue(row());
        await expect(service.resetDriverPasswordWithCode('john', '123456', 'newpassword')).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
        expect(resetCodes.claimAttempt).not.toHaveBeenCalled();
        expect(drivers.updatePasswordHash).not.toHaveBeenCalled();
      });

      it('concurrent use: loser of the consume race is rejected', async () => {
        resetCodes.find.mockResolvedValue(row());
        resetCodes.consume.mockResolvedValue(false);
        await expect(service.resetDriverPasswordWithCode('john', '123456', 'newpassword')).rejects.toThrow(AppException);
        expect(drivers.updatePasswordHash).not.toHaveBeenCalled();
      });
    });

    it('emails the code; a mail failure is swallowed (same 200)', async () => {
      tokens.signDriverPasswordResetToken = jest.fn().mockReturnValue('drv-reset');
      drivers.findByUsernameOrEmail.mockResolvedValue(drv);
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = false;
      mail.send.mockRejectedValueOnce(new Error('smtp down'));
      expect(await service.forgotDriverPassword('john')).toEqual({});
      await new Promise((r) => setImmediate(r));
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
      await new Promise((r) => setImmediate(r));
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

  describe('email lookup — case / whitespace-insensitive (login, Google, forgot)', () => {
    const stored = { ...activeUser, id: 'u-lower', email: 'john@x.com' };
    const legacy = { ...activeUser, id: 'u-legacy', email: 'Legacy.Mixed@Example.COM' };
    const google = (email: string) =>
      firebase.verifyIdToken.mockResolvedValue({ firebase: { sign_in_provider: 'google.com' }, email_verified: true, email, uid: 'g1' });

    beforeEach(() => {
      // The real repository over an in-memory table that evaluates the filter like Postgres ILIKE.
      const repo = new UserAuthRepository(fakeUserEmailTable([stored, legacy]).prisma as never);
      users.findByEmailWithRole.mockImplementation((email: string) => repo.findByEmailWithRole(email));
      sessions.create.mockResolvedValue({ id: 's1' });
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = true;
    });

    it.each([
      ['mixed case + spaces → lower-case row', '  John@X.COM ', 'u-lower'],
      ['lower-case input → legacy mixed-case row', 'legacy.mixed@example.com', 'u-legacy'],
      ['upper case + tab → legacy mixed-case row', '\tLEGACY.MIXED@EXAMPLE.COM', 'u-legacy'],
    ])('password login: %s', async (_label, input, id) => {
      await expect(service.loginUser(input, 'pw', {})).resolves.toMatchObject({ accessToken: 'access' });
      expect(users.touchLastActive).toHaveBeenCalledWith(id);
    });

    it('password login: unknown / wildcard address keeps the same INVALID_CREDENTIALS 401', async () => {
      for (const input of ['nobody@x.com', 'j_hn@x.com', '%']) {
        await expect(service.loginUser(input, 'pw', {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
      }
      expect(passwordUtil.verifyPassword).not.toHaveBeenCalled();
    });

    it('password login: wrong password on a case-variant address is the same INVALID_CREDENTIALS 401', async () => {
      (passwordUtil.verifyPassword as jest.Mock).mockResolvedValue(false);
      await expect(service.loginUser('JOHN@x.com', 'bad', {})).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    });

    it.each([
      ['John@X.com', 'u-lower'],
      ['legacy.mixed@EXAMPLE.com', 'u-legacy'],
    ])('Google sign-in with %j resolves the stored account', async (email, id) => {
      google(email);
      await expect(service.loginGoogle('tok', {})).resolves.toMatchObject({ accessToken: 'access' });
      expect(users.touchLastActive).toHaveBeenCalledWith(id);
    });

    it('Google invite acceptance: an INVITED row is activated whatever the case of the Google address', async () => {
      const invited = { ...stored, status: 'INVITED', invitedAt: new Date(Date.now() - 60_000) };
      const repo = new UserAuthRepository(fakeUserEmailTable([invited]).prisma as never);
      users.findByEmailWithRole.mockImplementation((email: string) => repo.findByEmailWithRole(email));
      users.activateInvited.mockResolvedValue({ ...invited, status: 'ACTIVE' });
      google('JOHN@X.COM');
      await expect(service.loginGoogle('tok', {})).resolves.toMatchObject({ accessToken: 'access' });
      expect(users.activateInvited).toHaveBeenCalledWith('u-lower');
    });

    it('Google sign-in: a look-alike address with `_` is still USER_NOT_INVITED', async () => {
      google('j_hn@x.com');
      await expect(service.loginGoogle('tok', {})).rejects.toMatchObject({ code: 'USER_NOT_INVITED', status: 403 });
    });

    it.each([' JOHN@x.com ', 'Legacy.Mixed@example.com'])('legacy forgotPassword(%j) issues a reset token', async (input) => {
      await expect(service.forgotPassword(input)).resolves.toEqual({ resetToken: 'reset-token' });
    });

    it('legacy forgotPassword with an unknown address still returns {}', async () => {
      await expect(service.forgotPassword('nobody@x.com')).resolves.toEqual({});
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

    it('B-84 hold — forgotPassword issues no reset token for an address changed inside USER_EMAIL_CHANGE_HOLD_HOURS', async () => {
      (config as unknown as { echoOneTimeSecrets: boolean }).echoOneTimeSecrets = true;
      config.get.mockImplementation((key: string) => (key === 'USER_EMAIL_CHANGE_HOLD_HOURS' ? 48 : undefined));
      users.findByEmailWithRole.mockResolvedValue({ ...activeUser, emailChangedAt: new Date(Date.now() - 3_600_000) });
      await expect(service.forgotPassword('a@b.com')).resolves.toEqual({});
      expect(tokens.signPasswordResetToken).not.toHaveBeenCalled();
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

  describe('assertUserReauth (driver email change)', () => {
    it('accepts the acting user\'s correct password', async () => {
      users.findByIdWithRole.mockResolvedValue(activeUser);
      await expect(service.assertUserReauth('u1', { currentPassword: 'pw' })).resolves.toBeUndefined();
      expect(passwordUtil.verifyPassword).toHaveBeenCalledWith('hash', 'pw');
    });

    it('a wrong password is a 401 REAUTH_FAILED on the currentPassword field', async () => {
      users.findByIdWithRole.mockResolvedValue(activeUser);
      (passwordUtil.verifyPassword as jest.Mock).mockResolvedValue(false);
      await expect(service.assertUserReauth('u1', { currentPassword: 'nope' })).rejects.toMatchObject({
        code: 'REAUTH_FAILED',
        status: 401,
        details: { currentPassword: 'Password is incorrect.' },
      });
    });

    it('a missing password is a 401 REAUTH_REQUIRED', async () => {
      users.findByIdWithRole.mockResolvedValue(activeUser);
      await expect(service.assertUserReauth('u1', {})).rejects.toMatchObject({ code: 'REAUTH_REQUIRED', status: 401 });
    });

    it('a Google-only account must re-authenticate with Google (fresh token of the same account)', async () => {
      users.findByIdWithRole.mockResolvedValue({ ...activeUser, passwordHash: null });
      await expect(service.assertUserReauth('u1', { currentPassword: 'pw' })).rejects.toMatchObject({ code: 'REAUTH_FAILED' });
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'A@B.com',
        auth_time: Math.floor(Date.now() / 1000),
      });
      await expect(service.assertUserReauth('u1', { reauthIdToken: 'id' })).resolves.toBeUndefined();
      firebase.verifyIdToken.mockResolvedValue({
        firebase: { sign_in_provider: 'google.com' },
        email_verified: true,
        email: 'a@b.com',
        auth_time: Math.floor(Date.now() / 1000) - 3600,
      });
      await expect(service.assertUserReauth('u1', { reauthIdToken: 'old' })).rejects.toMatchObject({ code: 'REAUTH_FAILED' });
    });
  });
});
