import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { PermissionMatrix } from '../../common/decorators/permission.types';
import type { ContextUser } from '../../core/context/request-context';
import { FirebaseService } from '../../core/firebase/firebase.service';
import { AppConfigService } from '../../core/config/config.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { CarrierRepository } from '../carrier/carrier.repository';
import { hashPassword, verifyPassword } from './lib/password.util';
import { randomOpaqueToken, sha256 } from './lib/hash.util';
import { TRANSACTIONAL_MAIL, TransactionalMailPort } from '../../core/mail/mail.port';
import { TokenService } from './token.service';
import { DriverAuthRepository } from './repositories/driver-auth.repository';
import { DriverSessionRepository } from './repositories/driver-session.repository';
import { SessionRepository } from './repositories/session.repository';
import { UserAuthRepository, UserWithRole } from './repositories/user-auth.repository';

/** How long a back-office invite stays acceptable after `invitedAt` (web §11.18 footer copy). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface AccessTokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
}

export type LoginResult = AccessTokenPair;

/**
 * MB-9 — `driverId` is additive on top of `AccessTokenPair` so the mobile app can name its
 * per-driver offline SQLite file (`onebook_{driverId}.db`, mobile/tz.md §5.5) without decoding
 * the JWT. Only `POST /auth/login/driver` returns this shape; the back-office `/auth/login`
 * and `/auth/google` responses are untouched.
 */
export interface DriverLoginResult extends AccessTokenPair {
  driverId: string;
}

/**
 * TZ §6 — password + Google login for `User`, password login for `Driver`, and
 * refresh-token rotation. Controllers stay thin; every rule from §6.1/§6.5 lives here so
 * it is exercised identically from both entry points.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UserAuthRepository,
    private readonly drivers: DriverAuthRepository,
    private readonly sessions: SessionRepository,
    private readonly driverSessions: DriverSessionRepository,
    private readonly tokens: TokenService,
    private readonly firebase: FirebaseService,
    private readonly config: AppConfigService,
    private readonly carrier: CarrierRepository,
    private readonly attachments: AttachmentsService,
    @Inject(TRANSACTIONAL_MAIL) private readonly mail: TransactionalMailPort,
  ) {}

  // ---------------------------------------------------------------------
  // Password login — User
  // ---------------------------------------------------------------------

  async loginUser(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    // B-25 — in `production` AUTH_MODE the back office must use Google Sign-In; password
    // login is blocked outright (before even touching the DB) so it can't be used as a
    // user-enumeration oracle either.
    if (this.config.get('AUTH_MODE') === 'production') {
      throw new AppException(
        ERROR_CODES.PASSWORD_LOGIN_DISABLED,
        'Password login is disabled in production — sign in with Google.',
        403,
      );
    }
    const user = await this.users.findByEmailWithRole(email);
    if (!user || !user.passwordHash || user.status !== 'ACTIVE') {
      throw new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password.', 401);
    }
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      throw new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password.', 401);
    }
    return this.completeUserLogin(user, meta);
  }

  // ---------------------------------------------------------------------
  // Password login — Driver
  // ---------------------------------------------------------------------

  async loginDriver(username: string, password: string, meta: RequestMeta): Promise<DriverLoginResult> {
    const driver = await this.drivers.findByUsername(username);
    if (!driver || driver.status !== 'ACTIVE') {
      throw new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid username or password.', 401);
    }
    const ok = await verifyPassword(driver.passwordHash, password);
    if (!ok) {
      throw new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid username or password.', 401);
    }
    const accessToken = this.tokens.signDriverAccessToken({ id: driver.id });
    const refreshToken = randomOpaqueToken();
    await this.driverSessions.create({
      driverId: driver.id,
      refreshHash: sha256(refreshToken),
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs('driver')),
    });
    return { accessToken, refreshToken, tokenType: 'Bearer', driverId: driver.id };
  }

  // ---------------------------------------------------------------------
  // Google Sign-In — User only (TZ §6.2).
  // ---------------------------------------------------------------------

  async loginGoogle(idToken: string, meta: RequestMeta): Promise<LoginResult> {
    if (!this.firebase.enabled) {
      throw new AppException(ERROR_CODES.SERVICE_UNAVAILABLE, 'Google Sign-In is not configured.', 503);
    }
    const decoded = await this.firebase.verifyIdToken(idToken).catch(() => {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Invalid Google ID token.', 401);
    });

    if (decoded.firebase?.sign_in_provider !== 'google.com') {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Token was not issued by Google Sign-In.', 401);
    }
    const expectedAud = this.config.get('FIREBASE_PROJECT_ID');
    if (expectedAud && decoded.aud !== expectedAud) {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Token audience does not match this project.', 401);
    }
    if (decoded.email_verified !== true) {
      throw new AppException(ERROR_CODES.EMAIL_NOT_VERIFIED, 'Google email is not verified.', 403);
    }
    const email = decoded.email;
    if (!email) {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Google token did not include an email.', 401);
    }

    // Rule 1 (TZ §6.2) — no auto-registration. Unknown email => 403 USER_NOT_INVITED.
    let user = await this.users.findByEmailWithRole(email);
    // An invite is accepted by the first Google sign-in with the invited address, within the
    // invite window (web §11.18 "expires in 7 days"; `POST /users/:id/resend-invite` renews it).
    if (user?.status === 'INVITED') {
      const invitedAt = user.invitedAt?.getTime();
      if (invitedAt === undefined || Date.now() - invitedAt > INVITE_TTL_MS) {
        throw new AppException(
          ERROR_CODES.USER_NOT_INVITED,
          'This invitation has expired. Ask an administrator to resend it.',
          403,
        );
      }
      user = await this.users.activateInvited(user.id);
    }
    if (!user || user.status !== 'ACTIVE') {
      throw new AppException(
        ERROR_CODES.USER_NOT_INVITED,
        'This Google account has not been invited to OneBook ELD.',
        403,
      );
    }
    if (!user.googleUid && decoded.uid) {
      await this.users.setGoogleUid(user.id, decoded.uid);
    }

    return this.completeUserLogin(user, meta);
  }

  private async completeUserLogin(user: UserWithRole, meta: RequestMeta): Promise<LoginResult> {
    await this.users.touchLastActive(user.id);
    return this.issueUserTokens(user, meta);
  }

  private async issueUserTokens(user: UserWithRole, meta: RequestMeta): Promise<AccessTokenPair> {
    const refreshToken = randomOpaqueToken();
    const session = await this.sessions.create({
      userId: user.id,
      refreshHash: sha256(refreshToken),
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs('user')),
    });
    const accessToken = this.tokens.signUserAccessToken({
      id: user.id,
      roleKey: user.role.key,
      permissions: user.role.permissions as PermissionMatrix,
      sessionId: session.id,
    });
    return { accessToken, refreshToken, tokenType: 'Bearer' };
  }

  // ---------------------------------------------------------------------
  // Refresh / logout / sessions
  // ---------------------------------------------------------------------

  async refresh(refreshToken: string, subjectType: 'user' | 'driver', meta: RequestMeta): Promise<AccessTokenPair> {
    return subjectType === 'user' ? this.refreshUser(refreshToken, meta) : this.refreshDriver(refreshToken, meta);
  }

  private async refreshUser(refreshToken: string, meta: RequestMeta): Promise<AccessTokenPair> {
    const hash = sha256(refreshToken);
    const session = await this.sessions.findByRefreshHash(hash);
    if (!session) throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Unknown refresh token.', 401);
    if (session.revokedAt) {
      // Reuse of an already-rotated/revoked refresh token — treat as compromise (TZ §6.5).
      await this.sessions.revokeAllForUser(session.userId);
      this.logger.warn({ userId: session.userId }, 'Refresh token reuse detected — all sessions revoked');
      throw new AppException(ERROR_CODES.REFRESH_TOKEN_REUSED, 'Refresh token was already used.', 401);
    }
    if (session.expiresAt < new Date()) {
      throw new AppException(ERROR_CODES.TOKEN_EXPIRED, 'Refresh token expired.', 401);
    }
    const user = await this.users.findByIdWithRole(session.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, 'User no longer exists.', 401);
    }

    await this.sessions.revoke(session.id);
    const newRefreshToken = randomOpaqueToken();
    const newSession = await this.sessions.create({
      userId: user.id,
      refreshHash: sha256(newRefreshToken),
      userAgent: meta.userAgent ?? session.userAgent ?? undefined,
      ip: meta.ip ?? session.ip ?? undefined,
      deviceLabel: session.deviceLabel ?? undefined,
      expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs('user')),
    });
    const accessToken = this.tokens.signUserAccessToken({
      id: user.id,
      roleKey: user.role.key,
      permissions: user.role.permissions as PermissionMatrix,
      sessionId: newSession.id,
    });
    return { accessToken, refreshToken: newRefreshToken, tokenType: 'Bearer' };
  }

  private async refreshDriver(refreshToken: string, meta: RequestMeta): Promise<AccessTokenPair> {
    const hash = sha256(refreshToken);
    const session = await this.driverSessions.findByRefreshHash(hash);
    if (!session) throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Unknown refresh token.', 401);
    if (session.revokedAt) {
      await this.driverSessions.revokeAllForDriver(session.driverId);
      throw new AppException(ERROR_CODES.REFRESH_TOKEN_REUSED, 'Refresh token was already used.', 401);
    }
    if (session.expiresAt < new Date()) {
      throw new AppException(ERROR_CODES.TOKEN_EXPIRED, 'Refresh token expired.', 401);
    }
    const driver = await this.drivers.findById(session.driverId);
    if (!driver || driver.status !== 'ACTIVE') {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Driver no longer exists.', 401);
    }

    await this.driverSessions.revoke(session.id);
    const newRefreshToken = randomOpaqueToken();
    await this.driverSessions.create({
      driverId: driver.id,
      refreshHash: sha256(newRefreshToken),
      userAgent: meta.userAgent ?? session.userAgent ?? undefined,
      ip: meta.ip ?? session.ip ?? undefined,
      deviceLabel: session.deviceLabel ?? undefined,
      appVersion: session.appVersion ?? undefined,
      expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs('driver')),
    });
    const accessToken = this.tokens.signDriverAccessToken({ id: driver.id });
    return { accessToken, refreshToken: newRefreshToken, tokenType: 'Bearer' };
  }

  async logout(subjectType: 'user' | 'driver', refreshToken: string): Promise<void> {
    const hash = sha256(refreshToken);
    if (subjectType === 'user') {
      const session = await this.sessions.findByRefreshHash(hash);
      if (session && !session.revokedAt) await this.sessions.revoke(session.id);
    } else {
      const session = await this.driverSessions.findByRefreshHash(hash);
      if (session && !session.revokedAt) await this.driverSessions.revoke(session.id);
    }
  }

  /** B-50 — `current` is derived from the `sid` claim on the caller's own access token
   * (`TokenService`), never guessed from `lastSeenAt`/IP heuristics. */
  async listUserSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.sessions.listActiveForUser(userId);
    return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
  }

  async revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.findActiveById(sessionId, userId);
    if (!session) throw AppException.notFound('Session not found.');
    await this.sessions.revoke(sessionId);
  }

  /** B-50 "Sign out everywhere" — revokes every other active session for the user, keeping
   * the caller's own current session (if known) alive. */
  async revokeAllUserSessions(userId: string, currentSessionId?: string): Promise<number> {
    return this.sessions.revokeAllForUserExcept(userId, currentSessionId);
  }

  // ---------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------

  async forgotPassword(email: string): Promise<{ resetToken?: string }> {
    const user = await this.users.findByEmailWithRole(email);
    // Always 200 regardless of whether the email exists — no user-enumeration oracle.
    if (!user) return {};
    const token = this.issueResetToken(user.id, user.passwordHash);
    this.logger.log({ userId: user.id }, 'Password reset requested (no mailer wired in Phase 1)');
    // Phase 1 has no outbound-email integration (TZ §14 covers in-app/push, not SMTP). The
    // token is returned directly outside production so the flow is testable end-to-end;
    // production callers must wire an email provider before relying on this endpoint.
    return this.config.echoOneTimeSecrets ? { resetToken: token } : {};
  }

  /** MR-31 — `POST /auth/driver/password/forgot`. Always resolves (no enumeration oracle): an
   * unknown identifier, a driver without email, or a mail failure all look identical. The
   * token is emailed; it is only echoed in dev (`DEV_ECHO_SECRETS`). */
  async forgotDriverPassword(identifier: string): Promise<{ resetToken?: string }> {
    const driver = await this.drivers.findByUsernameOrEmail(identifier);
    if (!driver || !driver.email) return {};
    const token = this.tokens.signDriverPasswordResetToken(driver.id, sha256(driver.passwordHash ?? ''));
    // Not awaited: waiting on the mail provider made a known identifier measurably slower than an
    // unknown one — a timing oracle that undid the "always 200" enumeration guard.
    void Promise.resolve()
      .then(() =>
        this.mail.send({
          to: driver.email as string,
          subject: 'Reset your OneBook ELD driver app password',
          text:
            `Use this code in the OneBook ELD app to choose a new password. It expires in 30 minutes.\n\n${token}\n\n` +
            'If you did not request this, ignore this email.',
        }),
      )
      .catch((err: unknown) => {
        this.logger.warn({ driverId: driver.id, err: String(err) }, 'Driver password-reset email failed');
      });
    return this.config.echoOneTimeSecrets ? { resetToken: token } : {};
  }

  /** MR-31 — completes the reset; single-use (token is bound to the old password hash) and
   * revokes every driver session (refresh tokens of a lost phone stop working). */
  async resetDriverPassword(token: string, newPassword: string): Promise<void> {
    const { driverId, passwordVersion } = this.tokens.verifyDriverPasswordResetToken(token);
    const driver = await this.drivers.findById(driverId);
    if (!driver || driver.deletedAt || sha256(driver.passwordHash ?? '') !== passwordVersion) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Reset token is no longer valid.', 401);
    }
    await this.drivers.updatePasswordHash(driverId, await hashPassword(newPassword));
    await this.driverSessions.revokeAllForDriver(driverId);
  }

  /** Used by `modules/users` (`POST /users`, `POST /users/:id/resend-invite`, TZ §11.7). */
  issueResetToken(userId: string, currentPasswordHash: string | null): string {
    return this.tokens.signPasswordResetToken(userId, sha256(currentPasswordHash ?? ''));
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const { userId, passwordVersion } = this.tokens.verifyPasswordResetToken(token);
    const user = await this.users.findByIdWithRole(userId);
    if (!user || sha256(user.passwordHash ?? '') !== passwordVersion) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Reset token is no longer valid.', 401);
    }
    const passwordHash = await hashPassword(newPassword);
    await this.users.updatePasswordHash(userId, passwordHash);
    await this.sessions.revokeAllForUser(userId);
  }

  // ---------------------------------------------------------------------
  // Email re-verification — B-84 `PATCH /users/:id { email }`
  // ---------------------------------------------------------------------

  /** Used by `modules/users` — the new address is not written to `User.email` until the
   * returned token comes back through `verifyEmailChange` (TZ §18-adjacent: a changed email
   * is itself a login-affecting change, so it should not take effect silently). Same
   * "return outside production only" convention as `forgotPassword` — no mailer in Phase 1. */
  issueUserEmailVerifyToken(userId: string, email: string): string | undefined {
    const token = this.tokens.signUserEmailVerifyToken(userId, email);
    return this.config.echoOneTimeSecrets ? token : undefined;
  }

  async verifyEmailChange(token: string): Promise<void> {
    const { userId, email } = this.tokens.verifyUserEmailVerifyToken(token);
    const user = await this.users.findByIdWithRole(userId);
    if (!user) throw new AppException(ERROR_CODES.TOKEN_INVALID, 'This verification link is no longer valid.', 401);
    const existing = await this.users.findByEmail(email);
    if (existing && existing.id !== userId) {
      throw AppException.conflict(`A user with email "${email}" already exists.`);
    }
    await this.users.applyVerifiedEmail(userId, email);
  }

  // ---------------------------------------------------------------------
  // B-34 — `GET /auth/me` topbar fields (avoids a second `/me/profile` round trip).
  // ---------------------------------------------------------------------

  /** Adds `fullName`, `email`, `avatarUrl`, `carrierName`, `homeTerminalTimezone` on top of
   * the raw token-claim principal, for a `user` subject only — drivers/api-keys get the
   * claims back unchanged (mobile has its own bootstrap payload, TZ §11.8). Carrier has no
   * per-user home-terminal timezone column; the account's carrier timezone is used, same
   * value the topbar would otherwise fetch via a second `/me/profile` call. */
  async meProfile(user: ContextUser): Promise<ContextUser | (ContextUser & Record<string, unknown>)> {
    if (user.type !== 'user') return user;
    const account = await this.users.findByIdWithRole(user.id);
    if (!account) return user;
    const [carrier, avatarUrl] = await Promise.all([
      this.carrier.get(),
      // Reuses the reusable presign helper (`AttachmentsService.presignKey`, §20 B-41)
      // rather than reaching for `STORAGE_PORT.presignGet` directly.
      account.avatarKey ? this.attachments.presignKey(account.avatarKey).then((r) => r.url) : Promise.resolve(null),
    ]);
    return {
      ...user,
      fullName: `${account.firstName} ${account.lastName}`.trim(),
      email: account.email,
      avatarUrl,
      carrierName: carrier?.name ?? null,
      homeTerminalTimezone: carrier?.timezone ?? null,
    };
  }

  static meta(req: Request): RequestMeta {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }
}
