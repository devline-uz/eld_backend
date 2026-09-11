import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';

/**
 * TZ §6.1 — two subject types. Mobile/ingest routes are for drivers only; a back-office
 * token must never post ELD events on a driver's behalf.
 */
@Injectable()
export class DriverGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    const user = RequestContext.user;
    if (!user) throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Authentication required.', 401);
    if (user.type !== 'driver') {
      throw new AppException(
        ERROR_CODES.DRIVER_CONTEXT_REQUIRED,
        'This endpoint requires a driver token.',
        403,
      );
    }
    return true;
  }
}
