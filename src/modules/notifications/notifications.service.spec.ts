import type { ContextUser } from '../../core/context/request-context';
import { NotificationsService } from './notifications.service';

function buildService() {
  const repo = {
    list: jest.fn(async () => ({ items: [], total: 0 })),
    counts: jest.fn(async () => ({ all: 3, violations: 1, maintenance: 1 })),
    markAllRead: jest.fn(async () => 2),
    markRead: jest.fn(async () => null as { id: string; readAt: Date | null } | null),
  };
  return { service: new NotificationsService(repo as never), repo };
}

const userActor: ContextUser = { id: 'usr_1', type: 'user' };

describe('NotificationsService — list (TZ §20 B-57)', () => {
  it('attaches counts to every list response', async () => {
    const { service, repo } = buildService();
    const result = await service.list(userActor, { page: 1, limit: 25, unreadOnly: false });
    expect(result.counts).toEqual({ all: 3, violations: 1, maintenance: 1 });
    expect(repo.counts).toHaveBeenCalledWith({ userId: 'usr_1' });
  });

  it('forwards the category filter to the repository', async () => {
    const { service, repo } = buildService();
    await service.list(userActor, { page: 1, limit: 25, unreadOnly: false, category: 'VIOLATIONS' });
    expect(repo.list).toHaveBeenCalledWith({ userId: 'usr_1' }, 1, 25, false, 'VIOLATIONS');
  });
});

describe('NotificationsService — markRead (TZ §20 B-56)', () => {
  it('returns { id, readAt } when the notification belongs to the caller', async () => {
    const { service, repo } = buildService();
    repo.markRead.mockResolvedValueOnce({ id: 'ntf_1', readAt: new Date('2026-09-24T00:00:00Z') });
    const result = await service.markRead(userActor, 'ntf_1');
    expect(result).toEqual({ id: 'ntf_1', readAt: new Date('2026-09-24T00:00:00Z') });
  });

  it('404s when the notification does not exist or belongs to someone else — never confirms which', async () => {
    const { service } = buildService();
    await expect(service.markRead(userActor, 'ntf_other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
