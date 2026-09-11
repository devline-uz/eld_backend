import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RequestContext } from '../../core/context/request-context';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';
import { ApiKeyVerifier } from './api-key-verifier.port';
import { TokenVerifier } from './token-verifier.port';

/** TZ §6.5 — plaintext API keys are minted as `obk_<random>`; that prefix is how this
 * transport-only guard tells an API key apart from a JWT without parsing either. */
const API_KEY_PREFIX = 'obk_';

/**
 * Extracts the bearer token, delegates verification to modules/auth (JWT) or
 * modules/api-keys (API key), and binds the resulting principal into the RequestContext
 * (TZ §27.1 point 3) so services, logs and the audit interceptor all see the same user
 * without threading it through signatures.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenVerifier,
    private readonly apiKeys: ApiKeyVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: unknown }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Missing bearer token.', 401);
    }

    const token = header.slice('Bearer '.length);
    const user = token.startsWith(API_KEY_PREFIX)
      ? await this.apiKeys.verify(token)
      : await this.tokens.verifyAccessToken(token);
    RequestContext.set('user', user);
    req.user = user;
    return true;
  }
}
