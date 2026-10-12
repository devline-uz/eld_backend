import { createHmac } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AUDIT_EVENT } from '../../common/interceptors/audit.interceptor';
import { ConfirmPasswordResetCodeDto } from './dto/auth.dto';
import * as passwordUtil from './lib/password.util';
import {
  PasswordResetCodeService,
  RESET_CODE_MAX_ATTEMPTS,
  RESET_CODE_RESEND_COOLDOWN_MS,
  RESET_CODE_TTL_MS,
} from './password-reset-code.service';

jest.mock('./lib/password.util');

type MockRepo = Record<string, jest.Mock>;
const SECRET = 'test-secret-test-secret-test-secret-32';
const hmac = (userId: string, code: string) => createHmac('sha256', SECRET).update(`${userId}:${code}`).digest('hex');

async function caught(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (err) {
    return err as AppException;
  }
  throw new Error('expected a rejection');
}

describe('PasswordResetCodeService (web "Forgot password?")', () => {
  let service: PasswordResetCodeService;
  let users: MockRepo;
  let codes: MockRepo;
  let sessions: MockRepo;
  let events: MockRepo;
  let mail: MockRepo;
  let env: Record<string, unknown>;
  let config: { get: jest.Mock; echoOneTimeSecrets: boolean };

  const activeUser = { id: 'u1', email: 'Sarah.Chen@example.com', firstName: 'Sarah', status: 'ACTIVE', role: { key: 'ADMIN' } };
  const liveCode = (overrides: Record<string, unknown> = {}) => ({
    id: 'c1',
    userId: 'u1',
    codeHash: hmac('u1', '123456'),
    attempts: 0,
    expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
    consumedAt: null,
    createdAt: new Date(Date.now() - 5 * 60 * 1000),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    users = { findByEmailInsensitiveWithRole: jest.fn().mockResolvedValue(activeUser), updatePasswordHash: jest.fn() };
    codes = {
      findLatestActive: jest.fn().mockResolvedValue(null),
      invalidateAllForUser: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'c-new' }),
      incrementAttempts: jest.fn(),
      consume: jest.fn().mockResolvedValue(true),
    };
    sessions = { revokeAllForUser: jest.fn() };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    mail = { send: jest.fn().mockResolvedValue({ delivered: true, reference: 'm1' }) };
    env = { AUTH_MODE: 'dev', JWT_SECRET: SECRET };
    config = { get: jest.fn((k: string) => env[k]), echoOneTimeSecrets: false };
    (passwordUtil.hashPassword as jest.Mock).mockResolvedValue('argon-new');
    service = new PasswordResetCodeService(
      users as never,
      codes as never,
      sessions as never,
      config as never,
      events as never,
      mail as never,
    );
  });

  describe('requestCode', () => {
    it('emails a 6-digit code to an existing active user and stores only its HMAC', async () => {
      const result = await service.requestCode(' sarah.chen@example.com ', { ip: '1.2.3.4' });

      expect(users.findByEmailInsensitiveWithRole).toHaveBeenCalledWith('sarah.chen@example.com');
      expect(result).toEqual({ success: true, email: activeUser.email, expiresInSec: 900, resendAfterSec: 60 });
      const [message] = mail.send.mock.calls[0] as [{ to: string; text: string }];
      expect(message.to).toBe(activeUser.email);
      const code = /Your verification code: (\d{6})/.exec(message.text)?.[1];
      expect(code).toMatch(/^\d{6}$/);
      const [stored] = codes.create.mock.calls[0] as [{ codeHash: string; expiresAt: Date }];
      expect(stored.codeHash).toBe(hmac('u1', code as string));
      expect(stored.codeHash).not.toContain(code);
      expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now() + RESET_CODE_TTL_MS - 5_000);
      expect(codes.invalidateAllForUser).toHaveBeenCalledWith('u1');
      expect(events.publish).toHaveBeenCalledWith(AUDIT_EVENT, expect.objectContaining({ action: 'PASSWORD_RESET_CODE_SENT', objectId: 'u1' }));
    });

    it('404s with a field error when no user has that email', async () => {
      users.findByEmailInsensitiveWithRole.mockResolvedValue(null);
      const err = await caught(service.requestCode('nobody@example.com'));
      expect(err.getStatus()).toBe(404);
      expect(err.code).toBe(ERROR_CODES.NOT_FOUND);
      expect(err.details).toEqual({ email: 'No account found with this email.' });
      expect(mail.send).not.toHaveBeenCalled();
    });

    it.each(['INVITED', 'DISABLED'])('treats a %s user as not found', async (status) => {
      users.findByEmailInsensitiveWithRole.mockResolvedValue({ ...activeUser, status });
      const err = await caught(service.requestCode('sarah.chen@example.com'));
      expect(err.getStatus()).toBe(404);
      expect(codes.create).not.toHaveBeenCalled();
    });

    it('refuses with 403 PASSWORD_LOGIN_DISABLED under AUTH_MODE=production, before touching the DB', async () => {
      env.AUTH_MODE = 'production';
      const err = await caught(service.requestCode('sarah.chen@example.com'));
      expect(err.getStatus()).toBe(403);
      expect(err.code).toBe(ERROR_CODES.PASSWORD_LOGIN_DISABLED);
      expect(users.findByEmailInsensitiveWithRole).not.toHaveBeenCalled();
    });

    it('enforces the resend cooldown with 429 + retryAfterSec', async () => {
      codes.findLatestActive.mockResolvedValue(liveCode({ createdAt: new Date(Date.now() - 20_000) }));
      const err = await caught(service.requestCode('sarah.chen@example.com'));
      expect(err.getStatus()).toBe(429);
      expect(err.code).toBe(ERROR_CODES.RATE_LIMITED);
      expect((err.details as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(30);
      expect(mail.send).not.toHaveBeenCalled();
    });

    it('allows a resend once the cooldown has passed and retires the old code', async () => {
      codes.findLatestActive.mockResolvedValue(liveCode({ createdAt: new Date(Date.now() - RESET_CODE_RESEND_COOLDOWN_MS - 1) }));
      await service.requestCode('sarah.chen@example.com');
      expect(codes.invalidateAllForUser).toHaveBeenCalledWith('u1');
      expect(codes.create).toHaveBeenCalled();
    });

    it('503s and retires the code when the email could not be sent (no echo)', async () => {
      mail.send.mockResolvedValue({ delivered: false, reference: 'NO_MAIL_TRANSPORT' });
      const err = await caught(service.requestCode('sarah.chen@example.com'));
      expect(err.getStatus()).toBe(503);
      expect(codes.consume).toHaveBeenCalledWith('c-new');
    });

    it('echoes the code only when DEV_ECHO_SECRETS allows it (works without SMTP)', async () => {
      config.echoOneTimeSecrets = true;
      mail.send.mockResolvedValue({ delivered: false, reference: 'NO_MAIL_TRANSPORT' });
      const result = await service.requestCode('sarah.chen@example.com');
      expect(result.code).toMatch(/^\d{6}$/);
      const [stored] = codes.create.mock.calls[0] as [{ codeHash: string }];
      expect(stored.codeHash).toBe(hmac('u1', result.code as string));
    });
  });

  describe('resetWithCode', () => {
    it('sets the new password, consumes the code and revokes every session', async () => {
      codes.findLatestActive.mockResolvedValue(liveCode());
      await service.resetWithCode('sarah.chen@example.com', '123456', 'N3wPassword!', { ip: '1.2.3.4' });

      expect(passwordUtil.hashPassword).toHaveBeenCalledWith('N3wPassword!');
      expect(users.updatePasswordHash).toHaveBeenCalledWith('u1', 'argon-new');
      expect(codes.consume).toHaveBeenCalledWith('c1');
      expect(codes.invalidateAllForUser).toHaveBeenCalledWith('u1');
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u1');
      expect(events.publish).toHaveBeenCalledWith(
        AUDIT_EVENT,
        expect.objectContaining({ action: 'PASSWORD_RESET', actorId: 'u1', actorType: 'user', objectType: 'User', ip: '1.2.3.4' }),
      );
    });

    it('rejects a wrong code with 422 RESET_CODE_INVALID and counts the attempt', async () => {
      codes.findLatestActive.mockResolvedValue(liveCode());
      codes.incrementAttempts.mockResolvedValue(1);
      const err = await caught(service.resetWithCode('sarah.chen@example.com', '000000', 'N3wPassword!'));
      expect(err.getStatus()).toBe(422);
      expect(err.code).toBe(ERROR_CODES.RESET_CODE_INVALID);
      expect(err.details).toEqual({ code: 'Incorrect code. 4 attempts left.', attemptsRemaining: 4 });
      expect(users.updatePasswordHash).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('locks the code on the last allowed wrong guess', async () => {
      codes.findLatestActive.mockResolvedValue(liveCode({ attempts: RESET_CODE_MAX_ATTEMPTS - 1 }));
      codes.incrementAttempts.mockResolvedValue(RESET_CODE_MAX_ATTEMPTS);
      const err = await caught(service.resetWithCode('sarah.chen@example.com', '000000', 'N3wPassword!'));
      expect(err.code).toBe(ERROR_CODES.RESET_CODE_EXPIRED);
      expect(err.message).toBe('Too many incorrect attempts. Request a new code.');
      expect(codes.consume).toHaveBeenCalledWith('c1');
    });

    it('refuses even the right code once the attempt limit is reached', async () => {
      codes.findLatestActive.mockResolvedValue(liveCode({ attempts: RESET_CODE_MAX_ATTEMPTS }));
      const err = await caught(service.resetWithCode('sarah.chen@example.com', '123456', 'N3wPassword!'));
      expect(err.code).toBe(ERROR_CODES.RESET_CODE_EXPIRED);
      expect(users.updatePasswordHash).not.toHaveBeenCalled();
    });

    it('refuses an expired code', async () => {
      codes.findLatestActive.mockResolvedValue(liveCode({ expiresAt: new Date(Date.now() - 1) }));
      const err = await caught(service.resetWithCode('sarah.chen@example.com', '123456', 'N3wPassword!'));
      expect(err.getStatus()).toBe(422);
      expect(err.code).toBe(ERROR_CODES.RESET_CODE_EXPIRED);
      expect(users.updatePasswordHash).not.toHaveBeenCalled();
    });

    it('refuses when no code was requested, or the user is gone', async () => {
      const err = await caught(service.resetWithCode('sarah.chen@example.com', '123456', 'N3wPassword!'));
      expect(err.code).toBe(ERROR_CODES.RESET_CODE_EXPIRED);
      users.findByEmailInsensitiveWithRole.mockResolvedValue(null);
      const err2 = await caught(service.resetWithCode('ghost@example.com', '123456', 'N3wPassword!'));
      expect(err2.code).toBe(ERROR_CODES.RESET_CODE_EXPIRED);
    });

    it('is single-use under a race: a lost consume() does not change the password', async () => {
      codes.findLatestActive.mockResolvedValue(liveCode());
      codes.consume.mockResolvedValue(false);
      const err = await caught(service.resetWithCode('sarah.chen@example.com', '123456', 'N3wPassword!'));
      expect(err.code).toBe(ERROR_CODES.RESET_CODE_EXPIRED);
      expect(users.updatePasswordHash).not.toHaveBeenCalled();
    });

    it('refuses with 403 under AUTH_MODE=production', async () => {
      env.AUTH_MODE = 'production';
      const err = await caught(service.resetWithCode('sarah.chen@example.com', '123456', 'N3wPassword!'));
      expect(err.code).toBe(ERROR_CODES.PASSWORD_LOGIN_DISABLED);
    });
  });

  describe('password policy (ConfirmPasswordResetCodeDto)', () => {
    const base = { email: 'a@b.com', code: '123456' };
    it('accepts 8+ characters', () => {
      expect(ConfirmPasswordResetCodeDto.safeParse({ ...base, newPassword: 'abcdefgh' }).success).toBe(true);
    });
    it('rejects fewer than 8 characters', () => {
      const r = ConfirmPasswordResetCodeDto.safeParse({ ...base, newPassword: 'short' });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]).toEqual(expect.objectContaining({ path: ['newPassword'], message: 'Password must be at least 8 characters.' }));
    });
    it('rejects more than 128 characters', () => {
      expect(ConfirmPasswordResetCodeDto.safeParse({ ...base, newPassword: 'x'.repeat(129) }).success).toBe(false);
    });
    it('rejects a code that is not 6 digits', () => {
      expect(ConfirmPasswordResetCodeDto.safeParse({ ...base, code: '12345a', newPassword: 'abcdefgh' }).success).toBe(false);
    });
  });
});
