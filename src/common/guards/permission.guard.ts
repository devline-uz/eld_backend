import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '../../core/context/request-context';
import { PERM_METADATA_KEY, PermRequirement, PermRequirementSet } from '../decorators/perm.decorator';
import { PermissionLevel } from '../decorators/permission.types';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';

const RANK: Record<PermissionLevel, number> = { NONE: 0, READ: 1, FULL: 2 };

/**
 * TZ §6.4 — enforces `@Perm(key, level)` against the permission matrix carried in the
 * token (`per` claim), surfaced through the RequestContext. Matrix *authoring* lives in
 * modules/roles; this guard only compares levels.
 *
 * B-13 — `@Perm` metadata can also be an array (via `PermAny`), meaning "any one of these";
 * `POST /vehicles/:id/assign-driver` is the first caller (`vehicles:FULL` OR `trips:FULL`).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermRequirementSet | undefined>(
      PERM_METADATA_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required) return true;
    const requirements: PermRequirement[] = Array.isArray(required) ? required : [required];

    const user = RequestContext.user;
    if (!user) throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);

    const grants = requirements.map((req) => ({ req, granted: user.permissions?.[req.key] ?? 'NONE' }));
    const satisfied = grants.some(({ req, granted }) => RANK[granted] >= RANK[req.level]);
    if (!satisfied) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Insufficient permission.', 403, {
        // Single-requirement handlers keep the original flat `{ key, required, granted }`
        // shape; multi-requirement ones (PermAny) list every option that was checked.
        ...(requirements.length === 1
          ? { key: requirements[0].key, required: requirements[0].level, granted: grants[0].granted }
          : { anyOf: grants.map(({ req, granted }) => ({ key: req.key, required: req.level, granted })) }),
      });
    }
    return true;
  }
}
