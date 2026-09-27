import { AlertRulesRepository } from './notifications.repository';

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
});
