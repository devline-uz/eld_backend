import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';

/**
 * CODE-079 — the mirror of `DriverGuard`: routes about the caller's own back-office account
 * (`/me/*`: profile, sessions, avatar, preferences) take the id from the token and read/write the
 * `User` table with it. A driver id or an `ApiKey.id` there is not a `User` row, so instead of a
 * 404/500 deep inside the service the caller gets a clear 403 up front.
 */
@Injectable()
export class UserGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    const user = RequestContext.user;
    if (!user) throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);
    if (user.type !== 'user') {
      throw new AppException(ERROR_CODES.USER_CONTEXT_REQUIRED, 'This endpoint requires a back-office user token.', 403);
    }
    return true;
  }
}
