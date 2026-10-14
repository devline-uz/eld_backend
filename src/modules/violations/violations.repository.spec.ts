/** CODE-069 — resolving a violation recounts the RODS day header flags in the same transaction. */
import { ViolationsRepository } from './violations.repository';
import type { PrismaService } from '../../core/prisma/prisma.service';

describe('ViolationsRepository.resolveIfOpen', () => {
  function build(won: boolean, openLeft: number) {
    const tx = {
      hosViolation: {
        updateMany: jest.fn().mockResolvedValue({ count: won ? 1 : 0 }),
        findUnique: jest.fn().mockResolvedValue({ driverId: 'drv-1', logDate: new Date('2026-10-08T00:00:00Z') }),
        count: jest.fn().mockResolvedValue(openLeft),
      },
      dailyLog: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
    return { tx, repo: new ViolationsRepository(prisma as unknown as PrismaService) };
  }
  const data = { resolvedAt: new Date(), resolvedById: 'usr-1', resolutionNote: 'Adverse weather' };

  it('clears the day flags when the last OPEN violation of the day is resolved', async () => {
    const { tx, repo } = build(true, 0);
    await expect(repo.resolveIfOpen('vio-1', data)).resolves.toBe(true);
    expect(tx.hosViolation.count).toHaveBeenCalledWith({
      where: { driverId: 'drv-1', logDate: new Date('2026-10-08T00:00:00Z'), status: 'OPEN' },
    });
    expect(tx.dailyLog.updateMany).toHaveBeenCalledWith({
      where: { driverId: 'drv-1', logDate: new Date('2026-10-08T00:00:00Z') },
      data: { hasViolation: false, violationCount: 0 },
    });
  });

  it('keeps the day flagged with the OPEN violations left', async () => {
    const { tx, repo } = build(true, 2);
    await repo.resolveIfOpen('vio-1', data);
    expect(tx.dailyLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { hasViolation: true, violationCount: 2 } }));
  });

  it('writes nothing to the header when the resolve lost a race', async () => {
    const { tx, repo } = build(false, 0);
    await expect(repo.resolveIfOpen('vio-1', data)).resolves.toBe(false);
    expect(tx.dailyLog.updateMany).not.toHaveBeenCalled();
  });
});
