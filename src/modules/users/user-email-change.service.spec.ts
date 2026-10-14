import type { User } from '@prisma/client';
import jwt from 'jsonwebtoken';
import type { AppConfigService } from '../../core/config/config.service';
import type { EventBusService } from '../../core/events/event-bus.service';
import type { AuthService } from '../auth/auth.service';
import { TokenService } from '../auth/token.service';
import { UserEmailChangeService } from './user-email-change.service';
import type { UsersRepository } from './users.repository';

const anyString = expect.any(String) as string;
const SECRET = 'test-secret-test-secret-test-secret-123';
const HOUR = 3_600_000;

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'usr_1',
    email: 'old@example.com',
    passwordHash: 'hash',
    googleUid: 'g-1',
    authProvider: 'PASSWORD',
    firstName: 'Dana',
    lastName: 'Ford',
    jobTitle: null,
    phone: null,
    roleId: 'role_1',
    status: 'ACTIVE',
    lastActiveAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    invitedById: null,
    invitedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    avatarKey: null,
    homeTerminalName: null,
    terminalScope: [],
    preferences: null,
    pendingEmail: null,
    pendingEmailRequestedAt: null,
    pendingEmailRequestedById: null,
    emailChangedAt: null,
    previousEmail: null,
    ...overrides,
  };
}

/** In-memory stand-in for the four repository calls the service makes, with the same
 * compare-and-set semantics as `updateMany({ where: { id, ...expect } })`. */
class FakeUsers {
  rows = new Map<string, User>();

  constructor(...users: User[]) {
    for (const u of users) this.rows.set(u.id, { ...u });
  }

  get(id: string): User {
    return this.rows.get(id) as User;
  }

  async findById({ id }: { id: string }) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findByEmailInsensitive(email: string) {
    return [...this.rows.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async findIdByPendingEmail(email: string, since: Date, exceptId?: string) {
    const row = [...this.rows.values()].find(
      (u) =>
        u.id !== exceptId &&
        u.pendingEmail?.toLowerCase() === email.toLowerCase() &&
        (u.pendingEmailRequestedAt?.getTime() ?? 0) > since.getTime(),
    );
    return row?.id ?? null;
  }

  async update({ id }: { id: string }, data: Partial<User>) {
    const next = { ...this.get(id), ...data };
    this.rows.set(id, next);
    return { ...next };
  }

  async updateIfState(id: string, expect: Record<string, unknown>, data: Partial<User>) {
    const row = this.rows.get(id);
    if (!row) return false;
    for (const [key, want] of Object.entries(expect)) {
      const have = (row as unknown as Record<string, unknown>)[key];
      const same =
        want instanceof Date || have instanceof Date
          ? (have as Date | null)?.getTime?.() === (want as Date | null)?.getTime?.()
          : (have ?? null) === (want ?? null);
      if (!same) return false;
    }
    this.rows.set(id, { ...row, ...data });
    return true;
  }
}

describe('UserEmailChangeService (B-84 web-user email change)', () => {
  let env: Record<string, unknown>;
  let config: { get: jest.Mock; echoOneTimeSecrets: boolean };
  let tokens: TokenService;
  let auth: { assertUserReauth: jest.Mock; revokeAllUserSessions: jest.Mock };
  let mail: { send: jest.Mock<Promise<{ delivered: boolean; reference: string }>, [SentMail]> };
  let events: { publish: jest.Mock<Promise<void>, [string, { action: string }]> };
  let repo: FakeUsers;
  let service: UserEmailChangeService;

  /** The `token` query param of the link in the n-th mail. */
  const tokenOf = (call: number): string => {
    const text = mail.send.mock.calls[call][0].text;
    const match = /token=([^\s]+)/.exec(text);
    if (!match) throw new Error('no link in mail');
    return decodeURIComponent(match[1]);
  };
  const auditActions = () => events.publish.mock.calls.map((c) => c[1].action);

  /** Runs the request half of `UsersService.update` (pending columns + notifications). */
  async function request(newEmail: string, at: Date) {
    const before = repo.get('usr_1');
    const updated = await repo.update({ id: 'usr_1' }, service.pendingInput(newEmail, 'adm_1', at) as Partial<User>);
    return service.notifyRequested(updated, before);
  }

  beforeEach(() => {
    env = {
      JWT_SECRET: SECRET,
      USER_EMAIL_CHANGE_TTL: '24h',
      DRIVER_EMAIL_CHANGE_TTL: '24h',
      USER_EMAIL_CHANGE_HOLD_HOURS: 48,
      WEB_APP_URL: 'https://panel.example.com',
    };
    config = { get: jest.fn((k: string) => env[k]), echoOneTimeSecrets: false };
    tokens = new TokenService(config as unknown as AppConfigService);
    auth = { assertUserReauth: jest.fn().mockResolvedValue(undefined), revokeAllUserSessions: jest.fn().mockResolvedValue(2) };
    mail = { send: jest.fn<Promise<{ delivered: boolean; reference: string }>, [SentMail]>().mockResolvedValue({ delivered: true, reference: 'm1' }) };
    events = { publish: jest.fn<Promise<void>, [string, { action: string }]>().mockResolvedValue(undefined) };
    repo = new FakeUsers(makeUser(), makeUser({ id: 'usr_2', email: 'taken@example.com', googleUid: null }));
    service = new UserEmailChangeService(
      repo as unknown as UsersRepository,
      tokens,
      auth as unknown as AuthService,
      config as unknown as AppConfigService,
      mail,
      events as unknown as EventBusService,
    );
  });

  describe('request', () => {
    it('stores the change as pending, mails the confirm link to the NEW address and a masked notice + cancel link to the OLD one', async () => {
      const view = await request('new.address@gmail.com', new Date());

      expect(repo.get('usr_1').email).toBe('old@example.com');
      expect(repo.get('usr_1').pendingEmail).toBe('new.address@gmail.com');
      expect(view).toEqual({ pendingEmail: 'new.address@gmail.com', emailDelivered: true });
      const [confirmMail, noticeMail] = mail.send.mock.calls.map((c) => c[0]);
      expect(confirmMail.to).toBe('new.address@gmail.com');
      expect(confirmMail.text).toContain('https://panel.example.com/account/email/confirm?token=');
      expect(confirmMail.text).toContain('24 hours');
      expect(noticeMail.to).toBe('old@example.com');
      expect(noticeMail.text).toContain('n***@g***.com');
      expect(noticeMail.text).not.toContain('new.address@gmail.com');
      expect(noticeMail.text).toContain('https://panel.example.com/account/email/cancel?token=');
      expect(noticeMail.text).toContain('48 hours');
      expect(auditActions()).toEqual(['EMAIL_CHANGE_REQUEST']);
    });

    it('signs the confirm link with USER_EMAIL_CHANGE_TTL (not the 30-minute password-reset TTL)', async () => {
      env.JWT_PASSWORD_RESET_TTL = '30m';
      await request('new@example.com', new Date());
      const claims = jwt.decode(tokenOf(0)) as { iat: number; exp: number; typ: string };
      expect(claims.typ).toBe('user_email_change');
      expect(claims.exp - claims.iat).toBe(24 * 3600);
    });

    it('echoes the confirm token only with DEV_ECHO_SECRETS and reports an undelivered mail without throwing', async () => {
      config.echoOneTimeSecrets = true;
      mail.send.mockResolvedValue({ delivered: false, reference: 'SMTP_NOT_CONFIGURED' });
      const view = await request('new@example.com', new Date());
      expect(view).toEqual({ pendingEmail: 'new@example.com', emailDelivered: false, verifyToken: anyString });
    });

    it('assertAvailable — 409 EMAIL_TAKEN for an address another user signs in with, or has pending', async () => {
      await expect(service.assertAvailable('TAKEN@example.com', 'usr_1')).rejects.toMatchObject({
        status: 409,
        code: 'EMAIL_TAKEN',
        details: { email: anyString },
      });
      await repo.update({ id: 'usr_2' }, { pendingEmail: 'wanted@example.com', pendingEmailRequestedAt: new Date() });
      await expect(service.assertAvailable('wanted@example.com', 'usr_1')).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
      // An expired pending change no longer reserves the address; the user's own address is fine.
      await repo.update({ id: 'usr_2' }, { pendingEmailRequestedAt: new Date(Date.now() - 25 * HOUR) });
      await expect(service.assertAvailable('wanted@example.com', 'usr_1')).resolves.toBeUndefined();
      await expect(service.assertAvailable('old@example.com', 'usr_1')).resolves.toBeUndefined();
    });

    it('assertAvailable without a userId (POST /users invite) — every account counts, case-insensitively', async () => {
      await expect(service.assertAvailable('OLD@Example.com')).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN', details: { email: anyString } });
      await repo.update({ id: 'usr_2' }, { pendingEmail: 'wanted@example.com', pendingEmailRequestedAt: new Date() });
      await expect(service.assertAvailable('wanted@example.com')).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
      await repo.update({ id: 'usr_2' }, { pendingEmailRequestedAt: new Date(Date.now() - 25 * HOUR) });
      await expect(service.assertAvailable('wanted@example.com')).resolves.toBeUndefined();
    });

    it('assertRequestable — re-authenticates the ACTING user; refused with 409 inside the hold of the previous change', async () => {
      await service.assertRequestable(repo.get('usr_1'), 'adm_1', { currentPassword: 'pw' });
      expect(auth.assertUserReauth).toHaveBeenCalledWith('adm_1', { currentPassword: 'pw' });

      auth.assertUserReauth.mockClear();
      const held = makeUser({ emailChangedAt: new Date(Date.now() - HOUR) });
      await expect(service.assertRequestable(held, 'adm_1', { currentPassword: 'pw' })).rejects.toMatchObject({
        status: 409,
        code: 'EMAIL_CHANGE_ON_HOLD',
        details: { holdUntil: anyString },
      });
      expect(auth.assertUserReauth).not.toHaveBeenCalled();
    });

    it('assertRequestable — a failed re-auth propagates', async () => {
      auth.assertUserReauth.mockRejectedValue(Object.assign(new Error('Password is incorrect.'), { code: 'REAUTH_FAILED' }));
      await expect(service.assertRequestable(repo.get('usr_1'), 'adm_1', { currentPassword: 'bad' })).rejects.toMatchObject({
        code: 'REAUTH_FAILED',
      });
    });
  });

  describe('confirm (POST /auth/email/verify)', () => {
    it('swaps the email, starts the hold, unbinds Google, clears the pending change and revokes every session', async () => {
      await request('new@example.com', new Date());
      const result = await service.confirm(tokenOf(0));

      expect(result).toEqual({ success: true, email: 'new@example.com', alreadyVerified: false });
      const row = repo.get('usr_1');
      expect(row).toMatchObject({
        email: 'new@example.com',
        previousEmail: 'old@example.com',
        googleUid: null,
        pendingEmail: null,
        pendingEmailRequestedAt: null,
        pendingEmailRequestedById: null,
      });
      expect(row.emailChangedAt).toBeInstanceOf(Date);
      expect(auth.revokeAllUserSessions).toHaveBeenCalledWith('usr_1');
      expect(auditActions()).toEqual(['EMAIL_CHANGE_REQUEST', 'EMAIL_CHANGE_CONFIRM']);
      expect(events.publish.mock.calls[1][1]).toMatchObject({ actorId: 'usr_1', actorType: 'user', objectType: 'User' });
    });

    it('a second click on the same link writes nothing and reports alreadyVerified', async () => {
      await request('new@example.com', new Date());
      const token = tokenOf(0);
      await service.confirm(token);
      auth.revokeAllUserSessions.mockClear();
      await expect(service.confirm(token)).resolves.toEqual({ success: true, email: 'new@example.com', alreadyVerified: true });
      expect(auth.revokeAllUserSessions).not.toHaveBeenCalled();
    });

    it('a stale link is rejected once a newer request replaced it (same or another address)', async () => {
      await request('first@example.com', new Date(Date.now() - 60_000));
      const stale = tokenOf(0);
      await request('second@example.com', new Date());
      const fresh = tokenOf(2);

      await expect(service.confirm(stale)).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
      expect(repo.get('usr_1').email).toBe('old@example.com');
      await expect(service.confirm(fresh)).resolves.toMatchObject({ email: 'second@example.com' });

      // Re-requesting the SAME address also retires the older link (new requestedAt).
      repo.rows.set('usr_1', makeUser());
      mail.send.mockClear();
      await request('same@example.com', new Date(Date.now() - 60_000));
      const older = tokenOf(0);
      await request('same@example.com', new Date());
      await expect(service.confirm(older)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    });

    it('409 when another user took the address after the request', async () => {
      await request('new@example.com', new Date());
      await repo.update({ id: 'usr_2' }, { email: 'new@example.com' });
      await expect(service.confirm(tokenOf(0))).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
      expect(repo.get('usr_1').email).toBe('old@example.com');
    });

    it('a cancel-link token or a driver token is never accepted as a confirm token', async () => {
      await request('new@example.com', new Date());
      await expect(service.confirm(tokenOf(1))).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
      const driverToken = tokens.signDriverEmailChangeToken('usr_1', 'new@example.com', new Date());
      await expect(service.confirm(driverToken)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    });
  });

  describe('cancel / revert (POST /auth/email/cancel)', () => {
    it('cancels a pending change; its confirm link then stops working', async () => {
      await request('new@example.com', new Date());
      const confirmToken = tokenOf(0);
      await expect(service.cancelFromLink(tokenOf(1))).resolves.toEqual({ success: true, result: 'CANCELLED' });
      expect(repo.get('usr_1')).toMatchObject({ email: 'old@example.com', pendingEmail: null });
      await expect(service.confirm(confirmToken)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
      expect(auditActions()).toContain('EMAIL_CHANGE_CANCEL');
    });

    it('inside the hold, reverts a confirmed change and revokes every session again', async () => {
      await request('new@example.com', new Date());
      const cancelToken = tokenOf(1);
      await service.confirm(tokenOf(0));
      auth.revokeAllUserSessions.mockClear();

      await expect(service.cancelFromLink(cancelToken)).resolves.toEqual({ success: true, result: 'REVERTED' });
      expect(repo.get('usr_1')).toMatchObject({ email: 'old@example.com', previousEmail: null, emailChangedAt: null });
      expect(auth.revokeAllUserSessions).toHaveBeenCalledWith('usr_1');
      expect(auditActions()).toEqual(['EMAIL_CHANGE_REQUEST', 'EMAIL_CHANGE_CONFIRM', 'EMAIL_CHANGE_REVERT']);
    });

    it('after the hold the link can no longer revert', async () => {
      await request('new@example.com', new Date(Date.now() - 50 * HOUR));
      // Cancel link signed with confirm TTL + hold; the change was confirmed 49 h ago.
      const cancelToken = tokenOf(1);
      await service.confirm(tokenOf(0)).catch(() => undefined);
      await repo.update({ id: 'usr_1' }, { email: 'new@example.com', previousEmail: 'old@example.com', emailChangedAt: new Date(Date.now() - 49 * HOUR), pendingEmail: null, pendingEmailRequestedAt: null });
      await expect(service.cancelFromLink(cancelToken)).rejects.toMatchObject({ status: 401, code: 'TOKEN_INVALID' });
      expect(repo.get('usr_1').email).toBe('new@example.com');
    });

    it('the cancel link of an older request cannot cancel a newer one', async () => {
      await request('first@example.com', new Date(Date.now() - 60_000));
      const oldCancel = tokenOf(1);
      await request('second@example.com', new Date());
      await expect(service.cancelFromLink(oldCancel)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
      expect(repo.get('usr_1').pendingEmail).toBe('second@example.com');
    });
  });

  describe('panel resend / cancel', () => {
    it('resend re-mails a confirm link for the SAME request (old links stay valid); cancelPending drops it', async () => {
      const at = new Date();
      await request('new@example.com', at);
      const first = tokenOf(0);
      const resent = await service.resend('usr_1');
      expect(resent).toEqual({ pendingEmail: 'new@example.com', emailedTo: 'new@example.com', emailDelivered: true });
      expect(mail.send.mock.calls[2][0].to).toBe('new@example.com');
      expect(repo.get('usr_1').pendingEmailRequestedAt?.getTime()).toBe(at.getTime());

      await service.cancelPending('usr_1');
      expect(repo.get('usr_1').pendingEmail).toBeNull();
      await expect(service.confirm(first)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    });

    it('resend / cancel without a pending change → 404 EMAIL_CHANGE_NOT_PENDING', async () => {
      await expect(service.resend('usr_1')).rejects.toMatchObject({ status: 404, code: 'EMAIL_CHANGE_NOT_PENDING' });
      await expect(service.cancelPending('usr_1')).rejects.toMatchObject({ status: 404, code: 'EMAIL_CHANGE_NOT_PENDING' });
    });
  });
});
