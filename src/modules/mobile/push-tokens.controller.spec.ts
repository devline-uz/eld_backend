import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { DriverGuard } from '../../common/guards/driver.guard';
import { RequestContext } from '../../core/context/request-context';
import { PushTokensController } from './push-tokens.controller';

describe('PushTokensController — driver-only guard', () => {
  it('is decorated with DriverGuard', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, PushTokensController) as unknown[]) ?? [];
    expect(guards).toContain(DriverGuard);
  });

  it('a back-office (type: user) token is rejected with 403 DRIVER_CONTEXT_REQUIRED', () => {
    const guard = new DriverGuard();
    RequestContext.run(
      { requestId: 'r1', traceId: 't1', startedAt: Date.now(), user: { id: 'usr_1', type: 'user' } },
      () => {
        try {
          guard.canActivate({} as never);
          fail('expected DriverGuard to throw');
        } catch (err) {
          expect(err).toBeInstanceOf(AppException);
          expect((err as AppException).code).toBe(ERROR_CODES.DRIVER_CONTEXT_REQUIRED);
          expect((err as AppException).getStatus()).toBe(403);
        }
      },
    );
  });

  it('a driver token passes', () => {
    const guard = new DriverGuard();
    RequestContext.run(
      { requestId: 'r2', traceId: 't2', startedAt: Date.now(), user: { id: 'drv_1', type: 'driver' } },
      () => {
        expect(guard.canActivate({} as never)).toBe(true);
      },
    );
  });
});
