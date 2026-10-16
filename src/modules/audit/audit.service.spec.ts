import { EditorType } from '@prisma/client';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';
import { EventBusService } from '../../core/events/event-bus.service';

/** B-62 — `GET /audit-log` rows carry `actorName`/`actorEmail` instead of a bare actor id. */
describe('AuditService.list — actorName/actorEmail (B-62)', () => {
  let repo: jest.Mocked<Pick<AuditRepository, 'list' | 'findActorNames'>>;
  let events: jest.Mocked<Pick<EventBusService, 'on'>>;
  let service: AuditService;

  beforeEach(() => {
    repo = { list: jest.fn(), findActorNames: jest.fn() };
    events = { on: jest.fn() };
    service = new AuditService(events as unknown as EventBusService, repo as unknown as AuditRepository);
  });

  it.each(['zzz', '1.5', '-1', '1e3'])('B3-09 a malformed cursor %p is a 422, never a 500 from BigInt()', async (cursor) => {
    await expect(service.list({}, 50, cursor)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, details: { cursor: expect.any(String) as string } });
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('B3-09 a numeric cursor is passed through', async () => {
    repo.list.mockResolvedValue({ items: [], nextCursor: null });
    repo.findActorNames.mockResolvedValue(new Map());
    await service.list({}, 50, '42');
    expect(repo.list).toHaveBeenCalledWith({}, 50, '42');
  });

  it('resolves actorName/actorEmail for USER rows via one batched lookup', async () => {
    repo.list.mockResolvedValue({
      items: [
        { id: 42n, actorId: 'usr_1', actorType: EditorType.USER, action: 'UPDATE', objectType: 'Role', objectId: 'role_1', before: null, after: null, detail: null, ip: null, userAgent: null, createdAt: new Date() },
      ] as never,
      nextCursor: null,
    });
    repo.findActorNames.mockResolvedValue(new Map([['usr_1', { name: 'Sarah Chen', email: 'sarah.chen@universal-logistics.com' }]]));

    const result = await service.list({}, 50);

    expect(repo.findActorNames).toHaveBeenCalledWith(['usr_1'], []);
    expect(result.items[0]).toMatchObject({
      id: '42',
      actorName: 'Sarah Chen',
      actorEmail: 'sarah.chen@universal-logistics.com',
    });
  });

  it('resolves actorName/actorEmail for DRIVER rows via the driver batch', async () => {
    repo.list.mockResolvedValue({
      items: [
        { id: 7n, actorId: 'drv_1', actorType: EditorType.DRIVER, action: 'CERTIFY', objectType: 'Log', objectId: 'log_1', before: null, after: null, detail: null, ip: null, userAgent: null, createdAt: new Date() },
      ] as never,
      nextCursor: null,
    });
    repo.findActorNames.mockResolvedValue(new Map([['drv_1', { name: 'John Smith', email: null }]]));

    const result = await service.list({}, 50);

    expect(repo.findActorNames).toHaveBeenCalledWith([], ['drv_1']);
    expect(result.items[0]).toMatchObject({ actorName: 'John Smith', actorEmail: null });
  });

  it('SYSTEM (API key) actors resolve to null/null — never crash on an unknown id', async () => {
    repo.list.mockResolvedValue({
      items: [
        { id: 9n, actorId: 'apikey_1', actorType: EditorType.SYSTEM, action: 'EXPORT', objectType: 'Report', objectId: 'rep_1', before: null, after: null, detail: null, ip: null, userAgent: null, createdAt: new Date() },
      ] as never,
      nextCursor: null,
    });
    repo.findActorNames.mockResolvedValue(new Map());

    const result = await service.list({}, 50);

    expect(repo.findActorNames).toHaveBeenCalledWith([], []);
    expect(result.items[0]).toMatchObject({ actorName: null, actorEmail: null });
  });
});
