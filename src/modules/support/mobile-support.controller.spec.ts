import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { DriverGuard } from '../../common/guards/driver.guard';
import { RequestContext } from '../../core/context/request-context';
import { MobileSupportController } from './mobile-support.controller';

describe('MobileSupportController', () => {
  const support = {
    createFeedbackForDriver: jest.fn(),
    createForDriver: jest.fn(),
    getForDriver: jest.fn(),
  };
  const repo = {
    findMany: jest.fn(),
  };
  const controller = new MobileSupportController(support as never, repo as never);

  beforeEach(() => jest.clearAllMocks());

  it('is decorated with DriverGuard', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, MobileSupportController) as unknown[]) ?? [];
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

  it('createFeedback delegates with a driver requester context', async () => {
    support.createFeedbackForDriver.mockResolvedValue({ id: 'fbk_1' });
    const dto = { answers: { q1: 'yes' } } as never;
    await controller.createFeedback(dto, { id: 'drv_1', type: 'driver' } as never);
    expect(support.createFeedbackForDriver).toHaveBeenCalledWith(dto, 'drv_1');
  });

  it('createTicket delegates with a driver requester context', async () => {
    support.createForDriver.mockResolvedValue({ id: 'tck_1' });
    const dto = { subject: 'Diagnostics', body: 'App logs', category: 'diagnostics', priority: 'NORMAL' } as never;
    await controller.createTicket(dto, { id: 'drv_1', type: 'driver' } as never);
    expect(support.createForDriver).toHaveBeenCalledWith(dto, 'drv_1');
  });

  it('listOwnTickets scopes by createdByDriverId and shapes the response', async () => {
    repo.findMany.mockResolvedValue([
      {
        id: 'tck_1',
        subject: 'App crashes',
        category: 'diagnostics',
        priority: 'NORMAL',
        status: 'OPEN',
        createdAt: new Date('2026-09-21T00:00:00.000Z'),
        updatedAt: new Date('2026-09-21T00:00:00.000Z'),
        body: 'irrelevant',
        number: 'TCK-000001',
      },
    ]);
    const result = await controller.listOwnTickets('drv_1');
    expect(repo.findMany).toHaveBeenCalledWith({ createdByDriverId: 'drv_1' }, undefined, { createdAt: 'desc' });
    expect(result).toEqual({
      items: [
        {
          id: 'tck_1',
          number: 'TCK-000001',
          body: 'irrelevant',
          contactMethod: null,
          subject: 'App crashes',
          category: 'diagnostics',
          priority: 'NORMAL',
          status: 'OPEN',
          createdAt: new Date('2026-09-21T00:00:00.000Z'),
          updatedAt: new Date('2026-09-21T00:00:00.000Z'),
        },
      ],
    });
  });

  it('getOwnTicket returns the driver-scoped ticket shape (MR-20)', async () => {
    support.getForDriver.mockResolvedValue({ id: 'tck_1', number: 'TCK-000001', subject: 's', body: 'b', category: null, priority: 'NORMAL', status: 'OPEN', createdAt: 1, updatedAt: 2 });
    const result = await controller.getOwnTicket('tck_1', 'drv_1');
    expect(support.getForDriver).toHaveBeenCalledWith('tck_1', 'drv_1');
    expect(result).toMatchObject({ id: 'tck_1', number: 'TCK-000001', body: 'b', contactMethod: null });
  });

  it('getOwnTicket returns the stored contactMethod (MR-20)', async () => {
    support.getForDriver.mockResolvedValue({ id: 'tck_2', number: 'TCK-000002', subject: 's', body: 'b', category: null, priority: 'NORMAL', status: 'OPEN', contactMethod: 'EMAIL', createdAt: 1, updatedAt: 2 });
    expect(await controller.getOwnTicket('tck_2', 'drv_1')).toMatchObject({ contactMethod: 'EMAIL' });
  });
});
