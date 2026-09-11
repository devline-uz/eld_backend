import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '../../core/context/request-context';
import { PERM_METADATA_KEY, PermRequirement } from '../decorators/perm.decorator';
import { PermissionLevel } from '../decorators/permission.types';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';

const RANK: Record<PermissionLevel, number> = { NONE: 0, READ: 1, FULL: 2 };

/**
 * TZ §6.4 — enforces `@Perm(key, level)` against the permission matrix carried in the
 * token (`per` claim), surfaced through the RequestContext. Matrix *authoring* lives in
 * modules/roles; this guard only compares levels.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermRequirement | undefined>(
      PERM_METADATA_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true;

    const user = RequestContext.user;
    if (!user) throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);

    const granted = user.permissions?.[required.key] ?? 'NONE';
    if (RANK[granted] < RANK[required.level]) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Insufficient permission.', 403, {
        key: required.key,
        required: required.level,
        granted,
      });
    }
    return true;
  }
}
