import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { PermissionMatrix } from '../../common/decorators/permission.types';
import { FirebaseService } from '../../core/firebase/firebase.service';
import { AppConfigService } from '../../core/config/config.service';
import { hashPassword, verifyPassword } from './lib/password.util';
import { randomOpaqueToken, sha256 } from './lib/hash.util';
import { TokenService } from './token.service';
import { DriverAuthRepository } from './repositories/driver-auth.repository';
import { DriverSessionRepository } from './repositories/driver-session.repository';
import { SessionRepository } from './repositories/session.repository';
import { UserAuthRepository, UserWithRole } from './repositories/user-auth.repository';

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

const REFRESH_TTL_MS: Record<'user' | 'driver', number> = {
  user: 30 * 24 * 60 * 60 * 1000,
  driver: 90 * 24 * 60 * 60 * 1000,
};

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
  ) {}

  // ---------------------------------------------------------------------
  // Password login — User
  // ---------------------------------------------------------------------

  async loginUser(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
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

  async loginDriver(username: string, password: string, meta: RequestMeta): Promise<AccessTokenPair> {
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
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS.driver),
    });
    return { accessToken, refreshToken, tokenType: 'Bearer' };
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
    const user = await this.users.findByEmailWithRole(email);
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
    const accessToken = this.tokens.signUserAccessToken({
      id: user.id,
      roleKey: user.role.key,
      permissions: user.role.permissions as PermissionMatrix,
    });
    const refreshToken = randomOpaqueToken();
    await this.sessions.create({
      userId: user.id,
      refreshHash: sha256(refreshToken),
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS.user),
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
    await this.sessions.create({
      userId: user.id,
      refreshHash: sha256(newRefreshToken),
      userAgent: meta.userAgent ?? session.userAgent ?? undefined,
      ip: meta.ip ?? session.ip ?? undefined,
      deviceLabel: session.deviceLabel ?? undefined,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS.user),
    });
    const accessToken = this.tokens.signUserAccessToken({
      id: user.id,
      roleKey: user.role.key,
      permissions: user.role.permissions as PermissionMatrix,
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
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS.driver),
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

  async listUserSessions(userId: string) {
    return this.sessions.listActiveForUser(userId);
  }

  async revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.sessions.findActiveById(sessionId, userId);
    if (!session) throw AppException.notFound('Session not found.');
    await this.sessions.revoke(sessionId);
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
    return this.config.isProduction ? {} : { resetToken: token };
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

  static meta(req: Request): RequestMeta {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }
}
