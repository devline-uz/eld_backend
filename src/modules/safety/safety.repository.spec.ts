import type { PrismaService } from '../../core/prisma/prisma.service';
import { SafetyRepository } from './safety.repository';

function build() {
  const prisma = {
    driverScore: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    safetyEvent: { groupBy: jest.fn(async () => []) },
    hosViolation: { groupBy: jest.fn(async () => [{ driverId: 'd1', _count: { _all: 2 } }]) },
    dailyLog: { groupBy: jest.fn(async () => [{ driverId: 'd1', _sum: { totalDistanceMi: 120 } }, { driverId: 'd2', _sum: { totalDistanceMi: null } }]) },
  };
  return { prisma, repo: new SafetyRepository(prisma as unknown as PrismaService) };
}

describe('SafetyRepository — scorecard queries (D-133)', () => {
  it('latestPeriod picks the max periodEnd (the old exact-equality default could never match)', async () => {
    const { prisma, repo } = build();
    await repo.latestPeriod();
    expect(prisma.driverScore.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ periodEnd: 'desc' }, { periodStart: 'asc' }] }),
    );
  });

  it('scorecard reads one period by its start day, ranked rows first', async () => {
    const { prisma, repo } = build();
    const start = new Date('2026-09-11T00:00:00.000Z');
    await repo.scorecard(start);
    expect(prisma.driverScore.findMany).toHaveBeenCalledWith({
      where: { periodStart: start },
      orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { milesDriven: 'desc' }, { driverId: 'asc' }],
    });
  });

  it('event counts exclude DISMISSED and use a half-open [from, to) window', async () => {
    const { prisma, repo } = build();
    const from = new Date('2026-09-11T04:00:00Z');
    const to = new Date('2026-10-11T04:00:00Z');
    await repo.eventCountsForDrivers(['d1'], from, to);
    expect(prisma.safetyEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['driverId', 'type', 'severity'],
        where: { driverId: { in: ['d1'] }, occurredAt: { gte: from, lt: to }, status: { not: 'DISMISSED' } },
      }),
    );
  });

  it('HOS violations exclude AUTO_CLEARED; miles default to 0', async () => {
    const { prisma, repo } = build();
    const a = new Date('2026-09-11T00:00:00Z');
    const b = new Date('2026-10-10T00:00:00Z');
    expect(await repo.hosViolationsByDriver(a, b)).toEqual(new Map([['d1', 2]]));
    expect(prisma.hosViolation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { logDate: { gte: a, lte: b }, status: { not: 'AUTO_CLEARED' } } }),
    );
    expect(await repo.milesByDriver(a, b)).toEqual(new Map([['d1', 120], ['d2', 0]]));
  });
});
