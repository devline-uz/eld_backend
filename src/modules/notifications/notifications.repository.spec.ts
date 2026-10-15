import { AlertDeliveryRepository, AlertRulesRepository, NotificationsRepository } from './notifications.repository';

function buildRepo(rows: Array<Record<string, unknown>>) {
  const prisma = {
    alertRule: {
      updateMany: jest.fn(async (..._args: unknown[]) => ({ count: 0 })),
      findMany: jest.fn(async (..._args: unknown[]) => rows),
    },
  };
  return { repo: new AlertRulesRepository(prisma as never), prisma };
}

describe('AlertRulesRepository.findByEvent (TZ §20 B-86 — mutedUntil)', () => {
  it('clears any expired mutedUntil before reading rules', async () => {
    const { repo, prisma } = buildRepo([{ id: 'alr_1', enabled: true, conditions: [{ event: 'alert.x' }] }]);
    await repo.findByEvent('alert.x');
    expect(prisma.alertRule.updateMany).toHaveBeenCalledTimes(1);
    const call = prisma.alertRule.updateMany.mock.calls[0][0] as { where: { mutedUntil: { lte: Date } }; data: { mutedUntil: null } };
    expect(call.where.mutedUntil.lte).toBeInstanceOf(Date);
    expect(call.data).toEqual({ mutedUntil: null });
  });

  it('only queries rules that are enabled and currently unmuted', async () => {
    const { repo, prisma } = buildRepo([{ id: 'alr_1', enabled: true, conditions: [{ event: 'alert.x' }] }]);
    await repo.findByEvent('alert.x');
    expect(prisma.alertRule.findMany).toHaveBeenCalledWith({ where: { enabled: true, mutedUntil: null } });
  });

  it('still filters by matching condition event after the mute clear', async () => {
    const { repo } = buildRepo([
      { id: 'alr_1', enabled: true, conditions: [{ event: 'alert.x' }] },
      { id: 'alr_2', enabled: true, conditions: [{ event: 'alert.y' }] },
    ]);
    const result = await repo.findByEvent('alert.x');
    expect(result.map((r) => r.id)).toEqual(['alr_1']);
  });

  it('LIVE-027: a rule built in the web editor (`safety.harsh`) fires on the worker job `alert.harsh_event`', async () => {
    const { repo } = buildRepo([
      { id: 'web_rule', enabled: true, conditions: [{ event: 'safety.harsh' }] },
      { id: 'other', enabled: true, conditions: [{ event: 'geofence.exit' }] },
    ]);
    const result = await repo.findByEvent('alert.harsh_event', {});
    expect(result.map((r) => r.id)).toEqual(['web_rule']);
  });

  it('LIVE-027: a break-due rule honours its "within N minutes" threshold', async () => {
    const { repo } = buildRepo([
      { id: 'within_30', enabled: true, conditions: [{ event: 'hos.break_due', params: { minutes: 30 } }] },
      { id: 'within_60', enabled: true, conditions: [{ event: 'hos.break_due', params: { minutes: 60 } }] },
    ]);
    // BE-12 — every step at or under the threshold matches; `AlertProcessor` delivers once per break.
    expect((await repo.findByEvent('alert.break_due', { minutesUntilBreak: 29 })).map((r) => r.id)).toEqual(['within_30', 'within_60']);
    expect((await repo.findByEvent('alert.break_due', { minutesUntilBreak: 45 })).map((r) => r.id)).toEqual(['within_60']);
  });
});

describe('AlertDeliveryRepository.existsForBreakEpisode — BE-12', () => {
  it('looks for any delivery of the rule to the recipient for that driver and break deadline', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({ id: 'del_1' }).mockResolvedValueOnce(null);
    const repo = new AlertDeliveryRepository({ alertDelivery: { findFirst } } as never);
    const episode = { driverId: 'drv_1', nextBreakDueAt: '2025-01-15T03:00:00.000Z' };
    await expect(repo.existsForBreakEpisode('alr_1', 'user:u1', episode)).resolves.toBe(true);
    await expect(repo.existsForBreakEpisode('alr_1', 'user:u1', episode)).resolves.toBe(false);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        alertRuleId: 'alr_1',
        recipient: 'user:u1',
        AND: [
          { payload: { path: ['driverId'], equals: 'drv_1' } },
          { payload: { path: ['nextBreakDueAt'], equals: '2025-01-15T03:00:00.000Z' } },
        ],
      },
      select: { id: true },
    });
  });
});

describe('NotificationsRepository — ELD connectivity segment', () => {
  function build(items: Array<Record<string, unknown>>) {
    const prisma = {
      notification: {
        findMany: jest.fn(async (..._args: unknown[]) => items),
        count: jest.fn(async (..._args: unknown[]) => 3),
      },
    };
    return { repo: new NotificationsRepository(prisma as never), prisma };
  }

  it('a CONNECTIVITY filter also picks up old DEVICE rows filed under MAINTENANCE, and reads them as CONNECTIVITY', async () => {
    const { repo, prisma } = build([{ id: 'n1', kind: 'DEVICE', category: 'MAINTENANCE' }]);
    const { items } = await repo.list({ userId: 'u1' }, 1, 25, false, 'CONNECTIVITY');
    const where = (prisma.notification.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.OR).toEqual([{ category: 'CONNECTIVITY' }, { category: 'MAINTENANCE', kind: 'DEVICE' }]);
    expect(items[0]).toMatchObject({ id: 'n1', category: 'CONNECTIVITY' });
  });

  it('the MAINTENANCE filter leaves device rows out', async () => {
    const { repo, prisma } = build([]);
    await repo.list({ userId: 'u1' }, 1, 25, false, 'MAINTENANCE');
    const where = (prisma.notification.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ category: 'MAINTENANCE', OR: [{ kind: null }, { kind: { not: 'DEVICE' } }] });
  });

  it('counts carry the connectivity segment', async () => {
    const { repo } = build([]);
    await expect(repo.counts({ userId: 'u1' })).resolves.toEqual({ all: 3, violations: 3, maintenance: 3, connectivity: 3 });
  });
});
