import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { DriverGuard } from '../../common/guards/driver.guard';
import { RequestContext } from '../../core/context/request-context';
import { MobileSupportController } from './mobile-support.controller';

describe('MobileSupportController', () => {
  const support = {
    createFeedback: jest.fn(),
    create: jest.fn(),
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
    support.createFeedback.mockResolvedValue({ id: 'fbk_1' });
    const dto = { answers: { q1: 'yes' } } as never;
    await controller.createFeedback(dto, { id: 'drv_1', type: 'driver' } as never);
    expect(support.createFeedback).toHaveBeenCalledWith(dto, { id: 'drv_1', type: 'driver' });
  });

  it('createTicket delegates with a driver requester context', async () => {
    support.create.mockResolvedValue({ id: 'tck_1' });
    const dto = { subject: 'Diagnostics', body: 'App logs', category: 'diagnostics', priority: 'NORMAL' } as never;
    await controller.createTicket(dto, { id: 'drv_1', type: 'driver' } as never);
    expect(support.create).toHaveBeenCalledWith(dto, { id: 'drv_1', type: 'driver' });
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
});
