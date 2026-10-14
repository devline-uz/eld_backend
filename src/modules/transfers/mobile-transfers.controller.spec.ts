import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DriverGuard } from '../../common/guards/driver.guard';
import { RequestContext } from '../../core/context/request-context';
import { MobileCreateTransferDto, MobileTransferListQueryDto } from './dto/mobile-transfers.dto';
import { MobileTransfersController } from './mobile-transfers.controller';

describe('MobileTransfersController (mobile/tz.md MB-4)', () => {
  const service = {
    create: jest.fn().mockResolvedValue({ id: 'trf_1', status: 'QUEUED', warnings: [] }),
    list: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 5 }),
  };
  const controller = new MobileTransfersController(service as never);
  const driver = { id: 'drv_1', type: 'driver' as const };

  it('is guarded by DriverGuard at class level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, MobileTransfersController) as unknown[];
    expect(guards).toContain(DriverGuard);
  });

  it('a back-office (type: user) token gets 403 DRIVER_CONTEXT_REQUIRED', () => {
    const guard = new DriverGuard();
    const ctx = { requestId: 'r', traceId: 't', startedAt: 0, user: { id: 'usr_1', type: 'user' as const, role: 'ADMIN', permissions: { reportsTransfer: 'FULL' as const } } };
    let thrown: unknown;
    try {
      RequestContext.run(ctx, () => guard.canActivate({} as never));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'DRIVER_CONTEXT_REQUIRED', status: 403 });
    const driverCtx = { ...ctx, user: driver };
    expect(RequestContext.run(driverCtx, () => guard.canActivate({} as never))).toBe(true);
  });

  it('create delegates with the token actor (never a body driverId)', async () => {
    const dto = MobileCreateTransferDto.parse({ method: 'WEB_SERVICES', rangeStart: '2026-09-03', rangeEnd: '2026-09-10', outputFileComment: 'ROADSIDE INSPECTION 2026-09-10' });
    await controller.create(dto, driver);
    expect(service.create).toHaveBeenCalledWith(driver, dto);
  });

  it('list delegates with limit default 5', async () => {
    const query = MobileTransferListQueryDto.parse({});
    expect(query.limit).toBe(5);
    await controller.list(query, driver);
    expect(service.list).toHaveBeenCalledWith(driver, query);
  });

  it('DTO: EMAIL requires a recipient, comment is capped at 60 chars, driverId is not accepted as a field', () => {
    expect(MobileCreateTransferDto.safeParse({ method: 'EMAIL', rangeStart: '2026-09-03', rangeEnd: '2026-09-10' }).success).toBe(false);
    expect(MobileCreateTransferDto.safeParse({ method: 'WEB_SERVICES', rangeStart: '2026-09-03', rangeEnd: '2026-09-10', outputFileComment: 'X'.repeat(61) }).success).toBe(false);
    const parsed = MobileCreateTransferDto.parse({ method: 'WEB_SERVICES', rangeStart: '2026-09-03', rangeEnd: '2026-09-10', driverId: 'drv_OTHER' });
    expect(parsed).not.toHaveProperty('driverId');
  });

  it('B-172 DTO: a YYYY-MM-DD bound stays a RODS day key (not UTC midnight); an ISO instant becomes a Date; bad dates fail', () => {
    const keys = MobileCreateTransferDto.parse({ method: 'WEB_SERVICES', rangeStart: '2026-10-06', rangeEnd: '2026-10-13' });
    expect(keys.rangeStart).toBe('2026-10-06');
    const instants = MobileCreateTransferDto.parse({ method: 'WEB_SERVICES', rangeStart: '2026-10-06T06:00:00Z', rangeEnd: '2026-10-14T05:59:00Z' });
    expect(instants.rangeEnd).toEqual(new Date('2026-10-14T05:59:00Z'));
    expect(MobileCreateTransferDto.safeParse({ method: 'WEB_SERVICES', rangeStart: '2026-02-30', rangeEnd: '2026-03-01' }).success).toBe(false);
    expect(MobileCreateTransferDto.safeParse({ method: 'WEB_SERVICES', rangeStart: 'nope', rangeEnd: '2026-03-01' }).success).toBe(false);
    expect(MobileCreateTransferDto.safeParse({ method: 'WEB_SERVICES', rangeStart: '2026-13-45', rangeEnd: '2026-03-01' }).success).toBe(false);
  });
});
