import { Injectable, Optional } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import ms from 'ms';
import type { ContextUser } from '../../core/context/request-context';
import { AppConfigService } from '../../core/config/config.service';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { TokenVerifier } from '../../common/guards/token-verifier.port';
import { PermissionMatrix } from '../../common/decorators/permission.types';
import { PrincipalStateService } from './principal-state.service';

export interface UserTokenSubject {
  id: string;
  roleKey: string;
  permissions: PermissionMatrix;
  /** B-50 — the `Session.id` this access token was issued alongside, so `GET /me/sessions`
   * can mark the caller's own session `current: true` without ever putting `refreshHash` in
   * the token or the response. */
  sessionId?: string;
}

export interface DriverTokenSubject {
  id: string;
  /** D-155 — the `DriverSession.id` issued alongside; lets the server find the caller's session family. */
  sessionId?: string;
}

const PASSWORD_RESET_TYP = 'password_reset';
const DRIVER_PASSWORD_RESET_TYP = 'driver_password_reset';
/** §20 B-29/B-30/B-31 — `POST /drivers/:id/send-verification` / `verify-email`. */
const DRIVER_EMAIL_VERIFY_TYP = 'driver_email_verify';
/** B-84 — `PATCH /users/:id { email }` confirm link mailed to the NEW address. Its own `typ` so
 * a driver link can never be replayed against a user (TZ §6.1 — two distinct subjects). Bound to
 * the pending address AND its request time (like the driver one), so a newer request or a cancel
 * invalidates every older link. (Replaces the unbound `user_email_verify` token: links issued
 * before the pending state existed no longer verify.) */
const USER_EMAIL_CHANGE_TYP = 'user_email_change';
/** B-84 — the "this wasn't me" link mailed to the OLD address of a web user. */
const USER_EMAIL_CHANGE_CANCEL_TYP = 'user_email_change_cancel';
/** Driver email change — the confirm link mailed to the NEW address. Bound to the pending
 * address AND its request time, so a newer request or a cancel invalidates every older link. */
const DRIVER_EMAIL_CHANGE_TYP = 'driver_email_change';
/** Driver email change — the "this wasn't me" link mailed to the OLD address. */
const DRIVER_EMAIL_CHANGE_CANCEL_TYP = 'driver_email_change_cancel';

interface AccessTokenClaims {
  sub: string;
  typ: 'user' | 'driver';
  rol?: string;
  per?: PermissionMatrix;
  /** B-50 — see `UserTokenSubject.sessionId`. */
  sid?: string;
}

interface PasswordResetClaims {
  sub: string;
  typ: typeof PASSWORD_RESET_TYP | typeof DRIVER_PASSWORD_RESET_TYP;
  /** Bound to the current passwordHash so a used/rotated hash invalidates outstanding tokens. */
  pwv: string;
}

interface DriverEmailVerifyClaims {
  sub: string;
  typ: typeof DRIVER_EMAIL_VERIFY_TYP;
  email: string;
}

interface DriverEmailChangeClaims {
  sub: string;
  typ: typeof DRIVER_EMAIL_CHANGE_TYP;
  /** The pending (new) address. */
  email: string;
  /** `pendingEmailRequestedAt` in epoch ms. */
  rqa: number;
}

interface DriverEmailChangeCancelClaims {
  sub: string;
  typ: typeof DRIVER_EMAIL_CHANGE_CANCEL_TYP;
  /** The requested (new) address. */
  email: string;
  /** The address the notice was mailed to (the one a revert restores). */
  old: string;
  rqa: number;
}

export interface DriverEmailChangeClaimsView {
  driverId: string;
  email: string;
  requestedAt: number;
}

interface UserEmailChangeClaims {
  sub: string;
  typ: typeof USER_EMAIL_CHANGE_TYP;
  /** The pending (new) address. */
  email: string;
  /** `pendingEmailRequestedAt` in epoch ms. */
  rqa: number;
}

interface UserEmailChangeCancelClaims {
  sub: string;
  typ: typeof USER_EMAIL_CHANGE_CANCEL_TYP;
  email: string;
  /** The address the notice was mailed to (the one a revert restores). */
  old: string;
  rqa: number;
}

export interface UserEmailChangeClaimsView {
  userId: string;
  email: string;
  requestedAt: number;
}

/**
 * TZ §6.3 — issues and verifies the JWTs described in the token-contents table, and is
 * the real binding for the transport-level `TokenVerifier` port (replacing
 * `NotImplementedTokenVerifier`). HS256 with `JWT_SECRET`; TZ §22.3 does not call for
 * asymmetric signing since verification only ever happens inside this one API.
 */
@Injectable()
export class TokenService extends TokenVerifier {
  constructor(
    private readonly config: AppConfigService,
    /** CODE-012 — optional only so token-format unit tests can build the service alone. */
    @Optional() private readonly principals?: PrincipalStateService,
  ) {
    super();
  }

  signUserAccessToken(user: UserTokenSubject): string {
    const claims: AccessTokenClaims = {
      sub: user.id,
      typ: 'user',
      rol: user.roleKey,
      per: user.permissions,
      sid: user.sessionId,
    };
    return jwt.sign(claims, this.secret, { expiresIn: this.config.get('JWT_ACCESS_TTL') } as jwt.SignOptions);
  }

  signDriverAccessToken(driver: DriverTokenSubject): string {
    const claims: AccessTokenClaims = { sub: driver.id, typ: 'driver', sid: driver.sessionId };
    return jwt.sign(claims, this.secret, {
      expiresIn: this.config.get('JWT_DRIVER_ACCESS_TTL'),
    } as jwt.SignOptions);
  }

  /** MR-31 — driver self-service reset. Own `typ` so a back-office reset token can never be
   * replayed against a driver (and vice versa); bound to the driver's current passwordHash. */
  signDriverPasswordResetToken(driverId: string, passwordVersion: string): string {
    const claims: PasswordResetClaims = { sub: driverId, typ: DRIVER_PASSWORD_RESET_TYP, pwv: passwordVersion };
    return jwt.sign(claims, this.secret, { expiresIn: this.config.get('JWT_PASSWORD_RESET_TTL') } as jwt.SignOptions);
  }

  verifyDriverPasswordResetToken(token: string): { driverId: string; passwordVersion: string } {
    const claims = this.verifyRaw<PasswordResetClaims>(token);
    if (claims.typ !== DRIVER_PASSWORD_RESET_TYP) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not a driver password-reset token.', 401);
    }
    return { driverId: claims.sub, passwordVersion: claims.pwv };
  }

  signPasswordResetToken(userId: string, passwordVersion: string): string {
    const claims: PasswordResetClaims = { sub: userId, typ: PASSWORD_RESET_TYP, pwv: passwordVersion };
    return jwt.sign(claims, this.secret, {
      expiresIn: this.config.get('JWT_PASSWORD_RESET_TTL'),
    } as jwt.SignOptions);
  }

  verifyPasswordResetToken(token: string): { userId: string; passwordVersion: string } {
    const claims = this.verifyRaw<PasswordResetClaims>(token);
    if (claims.typ !== PASSWORD_RESET_TYP) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not a password-reset token.', 401);
    }
    return { userId: claims.sub, passwordVersion: claims.pwv };
  }

  /** §20 B-29/B-30 — bound to the email so a subsequent change of `Driver.email` invalidates
   * outstanding links, same idea as `pwv` on password-reset tokens. */
  signDriverEmailVerifyToken(driverId: string, email: string): string {
    const claims: DriverEmailVerifyClaims = { sub: driverId, typ: DRIVER_EMAIL_VERIFY_TYP, email };
    return jwt.sign(claims, this.secret, { expiresIn: this.config.get('JWT_PASSWORD_RESET_TTL') } as jwt.SignOptions);
  }

  verifyDriverEmailVerifyToken(token: string): { driverId: string; email: string } {
    const claims = this.verifyRaw<DriverEmailVerifyClaims>(token);
    if (claims.typ !== DRIVER_EMAIL_VERIFY_TYP) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not an email-verification token.', 401);
    }
    return { driverId: claims.sub, email: claims.email };
  }

  /** Driver email change — confirm link for the NEW address (`DRIVER_EMAIL_CHANGE_TTL`). */
  signDriverEmailChangeToken(driverId: string, pendingEmail: string, requestedAt: Date): string {
    const claims: DriverEmailChangeClaims = { sub: driverId, typ: DRIVER_EMAIL_CHANGE_TYP, email: pendingEmail, rqa: requestedAt.getTime() };
    return jwt.sign(claims, this.secret, { expiresIn: this.config.get('DRIVER_EMAIL_CHANGE_TTL') } as jwt.SignOptions);
  }

  verifyDriverEmailChangeToken(token: string): DriverEmailChangeClaimsView {
    const claims = this.verifyRaw<DriverEmailChangeClaims>(token);
    if (claims.typ !== DRIVER_EMAIL_CHANGE_TYP || typeof claims.rqa !== 'number') {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not a driver email-change token.', 401);
    }
    return { driverId: claims.sub, email: claims.email, requestedAt: claims.rqa };
  }

  /** Driver email change — "this wasn't me" link for the OLD address. Lives for the confirm
   * window plus the post-change hold, so it can still revert a confirmed change. */
  signDriverEmailChangeCancelToken(driverId: string, newEmail: string, oldEmail: string, requestedAt: Date): string {
    const claims: DriverEmailChangeCancelClaims = {
      sub: driverId,
      typ: DRIVER_EMAIL_CHANGE_CANCEL_TYP,
      email: newEmail,
      old: oldEmail,
      rqa: requestedAt.getTime(),
    };
    const confirmMs = ms(this.config.get('DRIVER_EMAIL_CHANGE_TTL') as ms.StringValue);
    const holdMs = this.config.get('DRIVER_EMAIL_CHANGE_HOLD_HOURS') * 3_600_000;
    const ttlSec = Math.max(60, Math.ceil(((typeof confirmMs === 'number' ? confirmMs : 0) + holdMs) / 1000));
    return jwt.sign(claims, this.secret, { expiresIn: ttlSec });
  }

  verifyDriverEmailChangeCancelToken(token: string): DriverEmailChangeClaimsView & { oldEmail: string } {
    const claims = this.verifyRaw<DriverEmailChangeCancelClaims>(token);
    if (claims.typ !== DRIVER_EMAIL_CHANGE_CANCEL_TYP || typeof claims.rqa !== 'number') {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not a driver email-change cancel token.', 401);
    }
    return { driverId: claims.sub, email: claims.email, oldEmail: claims.old, requestedAt: claims.rqa };
  }

  /** B-84 — web-user email change confirm link for the NEW address (`USER_EMAIL_CHANGE_TTL`). */
  signUserEmailChangeToken(userId: string, pendingEmail: string, requestedAt: Date): string {
    const claims: UserEmailChangeClaims = { sub: userId, typ: USER_EMAIL_CHANGE_TYP, email: pendingEmail, rqa: requestedAt.getTime() };
    return jwt.sign(claims, this.secret, { expiresIn: this.config.get('USER_EMAIL_CHANGE_TTL') } as jwt.SignOptions);
  }

  verifyUserEmailChangeToken(token: string): UserEmailChangeClaimsView {
    const claims = this.verifyRaw<UserEmailChangeClaims>(token);
    if (claims.typ !== USER_EMAIL_CHANGE_TYP || typeof claims.rqa !== 'number') {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not a user email-change token.', 401);
    }
    return { userId: claims.sub, email: claims.email, requestedAt: claims.rqa };
  }

  /** B-84 — "this wasn't me" link for the OLD address of a web user. Lives for the confirm window
   * plus the post-change hold (`USER_EMAIL_CHANGE_HOLD_HOURS`), so it can still revert a confirmed change. */
  signUserEmailChangeCancelToken(userId: string, newEmail: string, oldEmail: string, requestedAt: Date): string {
    const claims: UserEmailChangeCancelClaims = {
      sub: userId,
      typ: USER_EMAIL_CHANGE_CANCEL_TYP,
      email: newEmail,
      old: oldEmail,
      rqa: requestedAt.getTime(),
    };
    const confirmMs = ms(this.config.get('USER_EMAIL_CHANGE_TTL') as ms.StringValue);
    const holdMs = this.config.get('USER_EMAIL_CHANGE_HOLD_HOURS') * 3_600_000;
    const ttlSec = Math.max(60, Math.ceil(((typeof confirmMs === 'number' ? confirmMs : 0) + holdMs) / 1000));
    return jwt.sign(claims, this.secret, { expiresIn: ttlSec });
  }

  verifyUserEmailChangeCancelToken(token: string): UserEmailChangeClaimsView & { oldEmail: string } {
    const claims = this.verifyRaw<UserEmailChangeCancelClaims>(token);
    if (claims.typ !== USER_EMAIL_CHANGE_CANCEL_TYP || typeof claims.rqa !== 'number') {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not a user email-change cancel token.', 401);
    }
    return { userId: claims.sub, email: claims.email, oldEmail: claims.old, requestedAt: claims.rqa };
  }

  /** TokenVerifier port — consumed by the transport-only `JwtAuthGuard`. */
  async verifyAccessToken(token: string): Promise<ContextUser> {
    const claims = this.verifyRaw<AccessTokenClaims>(token);
    if (claims.typ !== 'user' && claims.typ !== 'driver') {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not an access token.', 401);
    }
    if (claims.typ === 'user' && this.principals) {
      // CODE-012 — a disabled/deleted user, a revoked session or a changed role must take effect
      // before the token expires: state (and the permission matrix) comes from the DB.
      const live = await this.principals.resolveUser(claims.sub, claims.sid);
      if (!live) throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Session is no longer active.', 401);
      return { id: claims.sub, type: 'user', role: live.roleKey, permissions: live.permissions, sessionId: claims.sid };
    }
    if (claims.typ === 'driver' && this.principals) {
      // Driver disable — an INACTIVE/TERMINATED/deleted driver, or one whose app sessions were all
      // revoked, is cut off before the 24 h access token expires.
      const live = await this.principals.resolveDriver(claims.sub, claims.sid);
      if (!live) {
        // MD-195 — a takeover from another device is final and says who did it.
        const replaced = await this.principals.driverReplacement(claims.sub, claims.sid);
        if (replaced) {
          throw new AppException(ERROR_CODES.SESSION_REPLACED, 'Your account was signed in on another device.', 401, {
            byDeviceLabel: replaced.byDeviceLabel,
            at: replaced.at.toISOString(),
          });
        }
        throw new AppException(ERROR_CODES.DRIVER_DISABLED, 'Driver access has been revoked.', 401);
      }
    }
    return {
      id: claims.sub,
      type: claims.typ,
      role: claims.rol,
      permissions: claims.per,
      sessionId: claims.sid,
    };
  }

  /**
   * MB-21 — refresh-token DB expiry must honour `JWT_REFRESH_TTL` / `JWT_DRIVER_REFRESH_TTL`
   * (previously a hardcoded map in AuthService silently ignored these env vars). Reuses the
   * same duration-string format as the access-token TTLs above (`15m`, `24h`, `30d`, ...),
   * parsed with the `ms` package that `jsonwebtoken` itself depends on for `expiresIn`.
   */
  refreshTtlMs(subjectType: 'user' | 'driver'): number {
    const raw = subjectType === 'user' ? this.config.get('JWT_REFRESH_TTL') : this.config.get('JWT_DRIVER_REFRESH_TTL');
    const parsed = ms(raw as ms.StringValue);
    if (typeof parsed !== 'number' || Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`Invalid duration string for refresh TTL: "${raw}"`);
    }
    return parsed;
  }

  private get secret(): string {
    return this.config.get('JWT_SECRET');
  }

  private verifyRaw<T>(token: string): T {
    try {
      return jwt.verify(token, this.secret) as T;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppException(ERROR_CODES.TOKEN_EXPIRED, 'Token expired.', 401);
      }
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Invalid token.', 401);
    }
  }
}
