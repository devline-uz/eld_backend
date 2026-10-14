import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { PermissionMatrix, withRetiredKeysCleared } from '../../common/decorators/permission.types';
import { RequestContext, type ContextUser } from '../../core/context/request-context';
import { FirebaseService } from '../../core/firebase/firebase.service';
import { AppConfigService } from '../../core/config/config.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { CarrierRepository } from '../carrier/carrier.repository';
import { hashPassword, verifyPassword } from './lib/password.util';
import { randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import { randomOpaqueToken, sha256 } from './lib/hash.util';
import { isInEmailChangeHold } from './lib/driver-email-hold';
import { TRANSACTIONAL_MAIL, TransactionalMailPort } from '../../core/mail/mail.port';
import { TokenService } from './token.service';
import { PrincipalStateService } from './principal-state.service';
import { DriverAuthRepository } from './repositories/driver-auth.repository';
import { DriverResetCodeRepository } from './repositories/driver-reset-code.repository';
import { DriverSessionRepository } from './repositories/driver-session.repository';
import { SessionRepository } from './repositories/session.repository';
import { UserAuthRepository, UserWithRole } from './repositories/user-auth.repository';
import { RodsLoginRecorder } from '../logs/rods-login-recorder';
import { AUDIT_EVENT, type AuditEventPayload } from '../../common/interceptors/audit.interceptor';
import { EventBusService } from '../../core/events/event-bus.service';

/** How long a back-office invite stays acceptable after `invitedAt` (web §11.18 footer copy). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** MB-17 — driver reset-code policy (documented in Swagger on the forgot/reset endpoints). */
export const DRIVER_RESET_CODE_TTL_MS = 15 * 60 * 1000;
export const DRIVER_RESET_CODE_MAX_ATTEMPTS = 5;
/** CODE-019 — a rotated refresh token presented again this soon is a race (two tabs), not theft. */
export const REFRESH_RACE_GRACE_MS = 30_000;
/** CODE-082 — consecutive wrong passwords that lock a back-office account, and for how long. */
export const LOGIN_LOCK_THRESHOLD = 10;
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

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
    private readonly loginRecords: RodsLoginRecorder,
    private readonly resetCodes: DriverResetCodeRepository,
    private readonly principals: PrincipalStateService,
    @Optional() private readonly events?: EventBusService,
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
    // CODE-082 — per-account lockout on top of the 5/min/IP throttle (which a botnet sidesteps).
    // A wrong password always answers the same 401, locked or not, so the 423 is never an
    // enumeration oracle: only a caller who knows the password learns the account is locked.
    const lockedUntil = user.lockedUntil && user.lockedUntil.getTime() > Date.now() ? user.lockedUntil : null;
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      if (!lockedUntil) {
        const locked = await this.users.recordFailedLogin(user.id, LOGIN_LOCK_THRESHOLD, new Date(Date.now() + LOGIN_LOCK_MS));
        if (locked) this.audit('LOGIN_LOCKED', user.id, meta);
      }
      throw new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password.', 401);
    }
    if (lockedUntil) {
      const retryAfterSec = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
      throw new AppException(
        ERROR_CODES.ACCOUNT_LOCKED,
        'Too many failed sign-in attempts. Try again later or reset your password.',
        423,
        { retryAfterSec },
      );
    }
    await this.users.clearFailedLogins(user.id);
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
    // D-130 — §395 Appendix A 4.5.1.5: authenticating on an already-assigned unit is an ELD
    // login (idempotent: no second record while one is open on that unit; never throws).
    if (driver.assignedVehicleId) {
      await this.loginRecords.login(driver.id, driver.assignedVehicleId, 'AUTH_LOGIN');
    }
    this.audit('LOGIN', driver.id, meta, { objectType: 'Driver' });
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
    // CODE-082 — the first Google sign-in binds the account to that Google identity; afterwards
    // the same address re-issued to someone else (recycled Workspace mailbox) must not get in.
    // An email change clears the binding (`UserEmailChangeService`), so a legitimate new owner can link.
    if (user.googleUid && decoded.uid !== user.googleUid) {
      this.audit('LOGIN_REJECTED_GOOGLE_MISMATCH', user.id, meta);
      throw new AppException(
        ERROR_CODES.UNAUTHORIZED,
        'This Google account is not the one linked to this user. Ask an administrator for help.',
        401,
      );
    }
    if (!user.googleUid && decoded.uid) {
      await this.users.setGoogleUid(user.id, decoded.uid);
    }

    return this.completeUserLogin(user, meta);
  }

  private async completeUserLogin(user: UserWithRole, meta: RequestMeta): Promise<LoginResult> {
    await this.users.touchLastActive(user.id);
    const tokens = await this.issueUserTokens(user, meta);
    this.audit('LOGIN', user.id, meta);
    return tokens;
  }

  /**
   * CODE-083 — sign-in, sign-out and session revocations are security events (TZ §18), but they
   * have no `@Audit` route id to hang on, so they publish the same event the interceptor emits.
   * Fire-and-forget: an audit hiccup must never fail the sign-in it describes.
   */
  private audit(
    action: string,
    objectId: string,
    meta: RequestMeta = {},
    opts: { objectType?: 'User' | 'Driver'; actorId?: string; actorType?: 'user' | 'driver'; after?: Record<string, unknown> } = {},
  ): void {
    const objectType = opts.objectType ?? 'User';
    // An admin disabling a user or a "sign out everywhere" call acts as the signed-in caller; the
    // public sign-in routes have no caller yet, so the account itself is the actor.
    const caller = RequestContext.user;
    const payload: AuditEventPayload = {
      actorId: opts.actorId ?? caller?.id ?? objectId,
      actorType: opts.actorType ?? caller?.type ?? (objectType === 'Driver' ? 'driver' : 'user'),
      action,
      objectType,
      objectId,
      after: opts.after ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    void this.events?.publish(AUDIT_EVENT, payload);
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
      permissions: withRetiredKeysCleared(user.role.permissions as PermissionMatrix),
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
    if (session.revokedAt) throw await this.refreshReuse(session);
    if (session.expiresAt < new Date()) {
      throw new AppException(ERROR_CODES.TOKEN_EXPIRED, 'Refresh token expired.', 401);
    }
    const user = await this.users.findByIdWithRole(session.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, 'User no longer exists.', 401);
    }

    const newRefreshToken = randomOpaqueToken();
    // CODE-019 — atomic: of two requests presenting the same refresh token, exactly one rotates it.
    const newSession = await this.sessions.rotate(session.id, {
      userId: user.id,
      refreshHash: sha256(newRefreshToken),
      userAgent: meta.userAgent ?? session.userAgent ?? undefined,
      ip: meta.ip ?? session.ip ?? undefined,
      deviceLabel: session.deviceLabel ?? undefined,
      expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs('user')),
    });
    if (!newSession) {
      const latest = await this.sessions.findByRefreshHash(hash);
      throw await this.refreshReuse(latest ?? { ...session, revokedAt: new Date(), rotatedToId: null });
    }
    const accessToken = this.tokens.signUserAccessToken({
      id: user.id,
      roleKey: user.role.key,
      permissions: withRetiredKeysCleared(user.role.permissions as PermissionMatrix),
      sessionId: newSession.id,
    });
    return { accessToken, refreshToken: newRefreshToken, tokenType: 'Bearer' };
  }

  /**
   * A refresh token that is no longer the head of its session. Replayed long after rotation, or
   * after a sign-out, it is treated as stolen (TZ §6.5) and every session of the user ends. The
   * same token presented again within {@link REFRESH_RACE_GRACE_MS} of its own rotation is two
   * tabs/requests racing (CODE-019): that request is refused without signing the user out.
   */
  private async refreshReuse(session: { id: string; userId: string; revokedAt: Date | null; rotatedToId?: string | null }): Promise<AppException> {
    const racing =
      !!session.rotatedToId && !!session.revokedAt && Date.now() - session.revokedAt.getTime() < REFRESH_RACE_GRACE_MS;
    if (racing) {
      this.logger.log({ userId: session.userId }, 'Concurrent refresh of one token — refused without revoking');
      return new AppException(ERROR_CODES.REFRESH_TOKEN_ROTATED, 'Refresh token was just rotated by another request.', 401);
    }
    await this.sessions.revokeAllForUser(session.userId);
    await this.principals.invalidateUser(session.userId);
    this.logger.warn({ userId: session.userId }, 'Refresh token reuse detected — all sessions revoked');
    return new AppException(ERROR_CODES.REFRESH_TOKEN_REUSED, 'Refresh token was already used.', 401);
  }

  private async refreshDriver(refreshToken: string, meta: RequestMeta): Promise<AccessTokenPair> {
    const hash = sha256(refreshToken);
    const session = await this.driverSessions.findByRefreshHash(hash);
    if (!session) throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Unknown refresh token.', 401);
    if (session.revokedAt) {
      await this.driverSessions.revokeAllForDriver(session.driverId);
      await this.principals.invalidateDriver(session.driverId);
      throw new AppException(ERROR_CODES.REFRESH_TOKEN_REUSED, 'Refresh token was already used.', 401);
    }
    if (session.expiresAt < new Date()) {
      throw new AppException(ERROR_CODES.TOKEN_EXPIRED, 'Refresh token expired.', 401);
    }
    const driver = await this.drivers.findById(session.driverId);
    if (!driver || driver.status !== 'ACTIVE' || driver.deletedAt) {
      await this.driverSessions.revokeAllForDriver(session.driverId);
      await this.principals.invalidateDriver(session.driverId);
      throw new AppException(ERROR_CODES.DRIVER_DISABLED, 'Driver access has been revoked.', 401);
    }

    // New session first, then retire the old one: the driver always has a live session, so a
    // concurrent request on the current access token is never refused mid-rotation.
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
    await this.driverSessions.revoke(session.id);
    const accessToken = this.tokens.signDriverAccessToken({ id: driver.id });
    return { accessToken, refreshToken: newRefreshToken, tokenType: 'Bearer' };
  }

  /**
   * CODE-079 — only the caller's OWN session is revoked: a refresh token belonging to another
   * user/driver (leaked, or pasted by mistake) is ignored exactly like an unknown one, so this
   * endpoint can neither sign someone else out nor confirm that a token exists.
   */
  async logout(subjectType: 'user' | 'driver', refreshToken: string, subjectId: string, meta: RequestMeta = {}): Promise<void> {
    const hash = sha256(refreshToken);
    if (subjectType === 'user') {
      const session = await this.sessions.findByRefreshHash(hash);
      if (session && !session.revokedAt && session.userId === subjectId) {
        await this.sessions.revoke(session.id);
        await this.principals.invalidateUser(session.userId);
        this.audit('LOGOUT', subjectId, meta, { after: { sessionId: session.id } });
      }
    } else {
      const session = await this.driverSessions.findByRefreshHash(hash);
      const own = session && session.driverId === subjectId ? session : null;
      if (own && !own.revokedAt) {
        await this.driverSessions.revoke(own.id);
        this.audit('LOGOUT', subjectId, meta, { objectType: 'Driver', after: { sessionId: own.id } });
      }
      // D-130 — §395 Appendix A 4.5.1.5 logout record for the open login (none open = no record).
      await this.loginRecords.logout(subjectId, 'AUTH_LOGOUT');
    }
  }

  /** B-50 — `current` is derived from the `sid` claim on the caller's own access token
   * (`TokenService`), never guessed from `lastSeenAt`/IP heuristics. */
  async listUserSessions(userId: string, currentSessionId?: string) {
    const sessions = await this.sessions.listActiveForUser(userId);
    return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
  }

  async revokeUserSession(userId: string, sessionId: string, meta: RequestMeta = {}): Promise<void> {
    const session = await this.sessions.findActiveById(sessionId, userId);
    if (!session) throw AppException.notFound('Session not found.');
    await this.sessions.revoke(sessionId);
    await this.principals.invalidateUser(userId);
    this.audit('SESSION_REVOKED', userId, meta, { after: { sessionId } });
  }

  /** B-50 "Sign out everywhere" — revokes every other active session for the user, keeping
   * the caller's own current session (if known) alive. */
  async revokeAllUserSessions(userId: string, currentSessionId?: string, meta: RequestMeta = {}): Promise<number> {
    const revoked = await this.sessions.revokeAllForUserExcept(userId, currentSessionId);
    if (revoked > 0) {
      await this.principals.invalidateUser(userId);
      this.audit('SESSIONS_REVOKED', userId, meta, { after: { revoked, keptSessionId: currentSessionId ?? null } });
    }
    return revoked;
  }

  // ---------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------

  async forgotPassword(email: string): Promise<{ resetToken?: string }> {
    const user = await this.users.findByEmailWithRole(email);
    // Always 200 regardless of whether the email exists — no user-enumeration oracle.
    if (!user) return {};
    // B-84 email-change hold — a just-changed address is not trusted for recovery: no reset token
    // is issued for it (same rule as `POST /auth/password/reset-code`).
    if (isInEmailChangeHold(user.emailChangedAt, this.config.get('USER_EMAIL_CHANGE_HOLD_HOURS'))) return {};
    const token = this.issueResetToken(user.id, user.passwordHash);
    this.logger.log({ userId: user.id }, 'Password reset requested (no mailer wired in Phase 1)');
    // Phase 1 has no outbound-email integration (TZ §14 covers in-app/push, not SMTP). The
    // token is returned directly outside production so the flow is testable end-to-end;
    // production callers must wire an email provider before relying on this endpoint.
    return this.config.echoOneTimeSecrets ? { resetToken: token } : {};
  }

  /** MR-31/MB-16/MB-17 — `POST /auth/driver/password/forgot`. Always resolves (no enumeration
   * oracle): unknown identifier, email-less driver and mail failure all look identical. With an
   * email: a 6-digit code (15 min, 5 attempts, hashed at rest, a new request invalidates the old
   * one) is emailed. Without: the carrier's ADMINs get an in-app notification. Secrets are echoed
   * only in dev (`DEV_ECHO_SECRETS`); the code is never logged. */
  async forgotDriverPassword(identifier: string): Promise<{ resetToken?: string; resetCode?: string }> {
    const driver = await this.drivers.findByUsernameOrEmail(identifier);
    if (!driver) return {};
    // Driver email change hold — a just-changed address is not trusted for recovery yet: no code
    // is mailed to it; the admins are notified instead, exactly like a driver without an email.
    const onHold = Boolean(
      driver.email && isInEmailChangeHold(driver.emailChangedAt, this.config.get('DRIVER_EMAIL_CHANGE_HOLD_HOURS')),
    );
    if (!driver.email || onHold) {
      // Not awaited — same timing-oracle reasoning as the mail below.
      void Promise.resolve()
        .then(() =>
          this.resetCodes.notifyAdminsOfResetRequest(
            driver,
            new Date(Date.now() - DRIVER_RESET_CODE_TTL_MS),
            onHold ? 'EMAIL_CHANGE_HOLD' : 'NO_EMAIL',
          ),
        )
        .catch((err: unknown) => {
          this.logger.warn({ driverId: driver.id, err: String(err) }, 'Driver password-reset admin notification failed');
        });
      return {};
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const token = this.tokens.signDriverPasswordResetToken(driver.id, sha256(driver.passwordHash ?? ''));
    // Not awaited: waiting on the mail provider made a known identifier measurably slower than an
    // unknown one — a timing oracle that undid the "always 200" enumeration guard.
    void Promise.resolve()
      .then(() =>
        this.resetCodes.upsert(driver.id, salt, sha256(`${salt}:${code}`), new Date(Date.now() + DRIVER_RESET_CODE_TTL_MS)),
      )
      .then((issued) =>
        // B-158 — inside the per-driver cooldown no new code is stored, so none is mailed.
        issued === null ? undefined : this.mail.send({
          to: driver.email as string,
          subject: 'Your OneBook ELD password reset code',
          text:
            `Your OneBook ELD password reset code is ${code}\n\n` +
            `Enter it in the app to choose a new password. It expires in ${DRIVER_RESET_CODE_TTL_MS / 60_000} minutes ` +
            `and stops working after ${DRIVER_RESET_CODE_MAX_ATTEMPTS} wrong attempts.\n\n` +
            'If you did not request this, ignore this email.',
        }),
      )
      .catch((err: unknown) => {
        this.logger.warn({ driverId: driver.id, err: String(err) }, 'Driver password-reset email failed');
      });
    return this.config.echoOneTimeSecrets ? { resetToken: token, resetCode: code } : {};
  }

  /** MB-17 — completes a reset with `{username|email, code, newPassword}`. Every failure
   * (unknown driver, no/expired/exhausted code, wrong code) returns the same 401. */
  async resetDriverPasswordWithCode(identifier: string, code: string, newPassword: string): Promise<void> {
    const invalid = () => new AppException(ERROR_CODES.TOKEN_INVALID, 'The code is invalid, already used or expired.', 401);
    const driver = await this.drivers.findByUsernameOrEmail(identifier);
    if (!driver) throw invalid();
    // B-160 — 15 wrong codes in 24 h lock code reset for that driver for 24 h (same generic 401).
    if (await this.resetCodes.isLocked(driver.id, new Date())) throw invalid();
    const row = await this.resetCodes.find(driver.id);
    if (!row) throw invalid();
    if (row.expiresAt.getTime() <= Date.now() || row.attempts >= DRIVER_RESET_CODE_MAX_ATTEMPTS) {
      await this.resetCodes.consume(driver.id);
      throw invalid();
    }
    // B-158 — spend the attempt atomically BEFORE comparing: a read-then-increment let parallel
    // guesses all pass the stale `attempts` check and blow through the 5-attempt cap.
    if (!(await this.resetCodes.claimAttempt(driver.id, row.codeHash, DRIVER_RESET_CODE_MAX_ATTEMPTS, new Date()))) {
      throw invalid();
    }
    const expected = Buffer.from(row.codeHash, 'hex');
    const actual = Buffer.from(sha256(`${row.salt}:${code}`), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      if (row.attempts + 1 >= DRIVER_RESET_CODE_MAX_ATTEMPTS) await this.resetCodes.consume(driver.id);
      await this.resetCodes.recordFailure(driver.id, new Date());
      throw invalid();
    }
    // Single use: only the caller whose delete removed the row may proceed.
    if (!(await this.resetCodes.consume(driver.id))) throw invalid();
    await this.drivers.updatePasswordHash(driver.id, await hashPassword(newPassword));
    await this.driverSessions.revokeAllForDriver(driver.id);
    await this.principals.invalidateDriver(driver.id);
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
    await this.principals.invalidateDriver(driverId);
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
    await this.principals.invalidateUser(userId);
  }

  // ---------------------------------------------------------------------
  // Re-authentication of the acting web user (driver email change)
  // ---------------------------------------------------------------------

  /**
   * The acting back-office user re-confirms who they are before a sensitive change (a driver's
   * email). Password accounts re-enter their password (Argon2 `verifyPassword`); a Google-only
   * account (no password hash, or `AUTH_MODE=production` where passwords are off) sends a fresh
   * Firebase ID token of the same Google account instead. There is no 2FA in this project.
   * Every failure is a 401 with a non-session code, so the web keeps its own session.
   */
  async assertUserReauth(userId: string, proof: { currentPassword?: string; reauthIdToken?: string }): Promise<void> {
    const field = { currentPassword: 'Enter your password to confirm this change.' };
    const user = await this.users.findByIdWithRole(userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new AppException(ERROR_CODES.REAUTH_FAILED, 'Your account could not be re-verified.', 401, field);
    }
    if (proof.reauthIdToken) {
      await this.assertGoogleReauth(user, proof.reauthIdToken);
      return;
    }
    const passwordAllowed = this.config.get('AUTH_MODE') !== 'production' && Boolean(user.passwordHash);
    if (!proof.currentPassword) {
      throw new AppException(
        ERROR_CODES.REAUTH_REQUIRED,
        passwordAllowed ? 'Enter your password to change this email.' : 'Confirm with Google to change this email.',
        401,
        passwordAllowed ? field : { reauthIdToken: 'Confirm with Google to change this email.' },
      );
    }
    if (!passwordAllowed || !(await verifyPassword(user.passwordHash as string, proof.currentPassword))) {
      throw new AppException(ERROR_CODES.REAUTH_FAILED, 'Password is incorrect.', 401, { currentPassword: 'Password is incorrect.' });
    }
  }

  private async assertGoogleReauth(user: UserWithRole, idToken: string): Promise<void> {
    const fail = () =>
      new AppException(ERROR_CODES.REAUTH_FAILED, 'Google re-authentication failed.', 401, { reauthIdToken: 'Google re-authentication failed.' });
    if (!this.firebase.enabled) throw fail();
    const decoded = await this.firebase.verifyIdToken(idToken).catch(() => {
      throw fail();
    });
    const expectedAud = this.config.get('FIREBASE_PROJECT_ID');
    const authTimeMs = typeof decoded.auth_time === 'number' ? decoded.auth_time * 1000 : 0;
    if (
      decoded.firebase?.sign_in_provider !== 'google.com' ||
      (expectedAud && decoded.aud !== expectedAud) ||
      decoded.email_verified !== true ||
      decoded.email?.toLowerCase() !== user.email.toLowerCase() ||
      // A token minted from an old sign-in is not a re-authentication.
      Date.now() - authTimeMs > 5 * 60_000
    ) {
      throw fail();
    }
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
    if (user.type === 'driver') {
      // Mobile wave 4 (M-31 / D-120) — the ELD username (Appendix A 7.38) for the Driver ID line
      // and the phone-built eRODS file; claims stay as they were, the profile fields are additive.
      const driver = await this.drivers.findById(user.id);
      if (!driver) return user;
      return {
        ...user,
        username: driver.username,
        fullName: `${driver.firstName} ${driver.lastName}`.trim(),
        email: driver.email ?? null,
        homeTerminalTimezone: driver.homeTerminalTimezone,
      };
    }
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
