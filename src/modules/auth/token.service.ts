import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
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
  twoFactorEnabled: boolean;
}

export interface DriverTokenSubject {
  id: string;
}

/** Distinguishes the pending-2FA token from a real access token so it can't be replayed. */
const PENDING_2FA_TYP = 'pending_2fa';
const PASSWORD_RESET_TYP = 'password_reset';

interface AccessTokenClaims {
  sub: string;
  typ: 'user' | 'driver';
  rol?: string;
  per?: PermissionMatrix;
  tfa?: boolean;
}

interface PendingTwoFactorClaims {
  sub: string;
  typ: typeof PENDING_2FA_TYP;
}

interface PasswordResetClaims {
  sub: string;
  typ: typeof PASSWORD_RESET_TYP;
  /** Bound to the current passwordHash so a used/rotated hash invalidates outstanding tokens. */
  pwv: string;
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
      tfa: user.twoFactorEnabled,
    };
    return jwt.sign(claims, this.secret, { expiresIn: this.config.get('JWT_ACCESS_TTL') } as jwt.SignOptions);
  }

  signDriverAccessToken(driver: DriverTokenSubject): string {
    const claims: AccessTokenClaims = { sub: driver.id, typ: 'driver' };
    return jwt.sign(claims, this.secret, {
      expiresIn: this.config.get('JWT_DRIVER_ACCESS_TTL'),
    } as jwt.SignOptions);
  }

  signPendingTwoFactorToken(userId: string): string {
    const claims: PendingTwoFactorClaims = { sub: userId, typ: PENDING_2FA_TYP };
    return jwt.sign(claims, this.secret, {
      expiresIn: this.config.get('JWT_PENDING_2FA_TTL'),
    } as jwt.SignOptions);
  }

  verifyPendingTwoFactorToken(token: string): string {
    const claims = this.verifyRaw<PendingTwoFactorClaims>(token);
    if (claims.typ !== PENDING_2FA_TYP) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Not a pending-2FA token.', 401);
    }
    return claims.sub;
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
      twoFactorEnabled: claims.tfa,
    };
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
