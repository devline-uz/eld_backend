import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import ms from 'ms';
import type { ContextUser } from '../../core/context/request-context';
import { AppConfigService } from '../../core/config/config.service';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { TokenVerifier } from '../../common/guards/token-verifier.port';
import { PermissionMatrix } from '../../common/decorators/permission.types';

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
}

const PASSWORD_RESET_TYP = 'password_reset';
const DRIVER_PASSWORD_RESET_TYP = 'driver_password_reset';
/** §20 B-29/B-30/B-31 — `POST /drivers/:id/send-verification` / `verify-email`. */
const DRIVER_EMAIL_VERIFY_TYP = 'driver_email_verify';
/** B-84 — `PATCH /users/:id { email }` re-verification. Same shape as the driver one above,
 * kept as its own `typ` so a driver verify link can never be replayed against a user (TZ §6.1
 * — two distinct subjects, never cross-usable). */
const USER_EMAIL_VERIFY_TYP = 'user_email_verify';

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

interface UserEmailVerifyClaims {
  sub: string;
  typ: typeof USER_EMAIL_VERIFY_TYP;
  email: string;
}

/**
 * TZ §6.3 — issues and verifies the JWTs described in the token-contents table, and is
 * the real binding for the transport-level `TokenVerifier` port (replacing
 * `NotImplementedTokenVerifier`). HS256 with `JWT_SECRET`; TZ §22.3 does not call for
 * asymmetric signing since verification only ever happens inside this one API.
 */
@Injectable()
export class TokenService extends TokenVerifier {
  constructor(private readonly config: AppConfigService) {
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
    const claims: AccessTokenClaims = { sub: driver.id, typ: 'driver' };
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

  /** B-84 — `PATCH /users/:id { email }` issues one of these; the caller only ever applies
   * the new email once this comes back verified (no outbound-mail transport yet, see
   * `AuthService.forgotPassword` — same "return outside production" convention). */
  signUserEmailVerifyToken(userId: string, email: string): string {
    const claims: UserEmailVerifyClaims = { sub: userId, typ: USER_EMAIL_VERIFY_TYP, email };
    return jwt.sign(claims, this.secret, { expiresIn: this.config.get('JWT_PASSWORD_RESET_TTL') } as jwt.SignOptions);
  }

  verifyUserEmailVerifyToken(token: string): { userId: string; email: string } {
    const claims = this.verifyRaw<UserEmailVerifyClaims>(token);
    if (claims.typ !== USER_EMAIL_VERIFY_TYP) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not a user email-verification token.', 401);
    }
    return { userId: claims.sub, email: claims.email };
  }

  /** TokenVerifier port — consumed by the transport-only `JwtAuthGuard`. */
  async verifyAccessToken(token: string): Promise<ContextUser> {
    const claims = this.verifyRaw<AccessTokenClaims>(token);
    if (claims.typ !== 'user' && claims.typ !== 'driver') {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not an access token.', 401);
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
