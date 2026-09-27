import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { DriverGuard } from '../../common/guards/driver.guard';
import { RequestContext } from '../../core/context/request-context';
import { MobileCoDriverController } from './mobile-codriver.controller';
import { MobileContactsController } from './mobile-contacts.controller';
import { MobileDvirHistoryController } from './mobile-dvir-history.controller';
import { MobileTripController } from './mobile-trip.controller';
import { MobileVehicleController } from './mobile-vehicle.controller';

/** Phase 6b MB-2/MB-3/MB-5/MB-10/MB-14 — every new controller is driver-only. */
describe.each([
  ['MobileVehicleController', MobileVehicleController],
  ['MobileCoDriverController', MobileCoDriverController],
  ['MobileTripController', MobileTripController],
  ['MobileDvirHistoryController', MobileDvirHistoryController],
  ['MobileContactsController', MobileContactsController],
])('%s — driver-only guard', (_name, controller) => {
  it('is decorated with DriverGuard', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? [];
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
        }
      },
    );
  });
});
