import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';

/**
 * Injects the authenticated principal. Reads from the RequestContext (TZ §27.1 point 3)
 * with the request object as a fallback for non-HTTP execution contexts.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof ContextUser | undefined, ctx: ExecutionContext): unknown => {
    const user = RequestContext.user ?? ctx.switchToHttp().getRequest<{ user?: ContextUser }>().user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
