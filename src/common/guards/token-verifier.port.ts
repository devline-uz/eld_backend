import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { AppException } from '../errors/app.exception';

/**
 * Port between the transport-level JwtAuthGuard and the auth module.
 * Implemented by `modules/auth` (owner: eld-auth-rbac). The guard below stays
 * transport-only so token issuance/rotation rules live in exactly one place (TZ §6.3).
 */
export abstract class TokenVerifier {
  abstract verifyAccessToken(token: string): Promise<ContextUser>;
}

export const TOKEN_VERIFIER = TokenVerifier;

/** Default binding until modules/auth lands. */
@Injectable()
export class NotImplementedTokenVerifier extends TokenVerifier {
  verifyAccessToken(_token: string): Promise<ContextUser> {
    return Promise.reject(AppException.notImplemented('JWT verification (modules/auth)'));
  }
}
