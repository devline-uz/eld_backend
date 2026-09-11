import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '../../core/context/request-context';
import { TWO_FACTOR_EXEMPT_KEY } from '../decorators/two-factor-exempt.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';

/**
 * TZ §6.2 — "ADMIN uchun 2FA majburiy": an ADMIN whose `twoFactorEnabled` is false may
 * only reach routes marked `@TwoFactorExempt()` (2FA enrolment, `/me/*`, logout). Every
 * other route returns `403 TWO_FACTOR_SETUP_REQUIRED`. Runs after JwtAuthGuard so
 * `RequestContext.user` is already bound; runs before PermissionGuard so a locked-out
 * admin never leaks a permission-shaped 403 instead of this one.
 */
@Injectable()
export class TwoFactorSetupGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const user = RequestContext.user;
    if (!user || user.type !== 'user' || user.role !== 'ADMIN') return true;
    if (user.twoFactorEnabled) return true;

    const exempt = this.reflector.getAllAndOverride<boolean | undefined>(TWO_FACTOR_EXEMPT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (exempt) return true;

    throw new AppException(
      ERROR_CODES.TWO_FACTOR_SETUP_REQUIRED,
      'Admin accounts must configure 2FA before using this endpoint.',
      403,
    );
  }
}
