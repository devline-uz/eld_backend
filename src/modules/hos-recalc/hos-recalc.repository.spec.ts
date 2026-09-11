/** TZ §8.4 — the violation write rules at the Prisma boundary. */
import { HosRecalcRepository } from './hos-recalc.repository';
import type { PrismaService } from '../../core/prisma/prisma.service';

describe('HosRecalcRepository', () => {
  const prisma = {
    driver: { findUnique: jest.fn() },
    eldEvent: { findMany: jest.fn() },
    dailyLog: { findMany: jest.fn(), updateMany: jest.fn() },
    hosViolation: { findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  };

  /** Typed view of a recorded call, so the assertions below stay free of `any`. */
  const lastArgs = (mock: jest.Mock): Record<string, Record<string, unknown>> => {
    const calls = mock.mock.calls as unknown[][];
    return calls[calls.length - 1][0] as Record<string, Record<string, unknown>>;
  };
  const repo = new HosRecalcRepository(prisma as unknown as PrismaService);

  beforeEach(() => jest.clearAllMocks());

  it('loads a driver by id', async () => {
    await repo.findDriver('driver-1');
    expect(prisma.driver.findUnique).toHaveBeenCalledWith({ where: { id: 'driver-1' } });
  });

  it('reads only active §395 records, in order', async () => {
    await repo.findEvents('driver-1', new Date('2025-01-05T00:00:00Z'), new Date('2025-01-14T00:00:00Z'));
    expect(prisma.eldEvent.findMany).toHaveBeenCalledWith({
      where: { driverId: 'driver-1', recordStatus: 1, eventDateTime: { gte: new Date('2025-01-05T00:00:00Z'), lte: new Date('2025-01-14T00:00:00Z') } },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  });

  it('reads the daily log history in date order', async () => {
    await repo.findDailyLogs('driver-1', new Date('2025-01-05T00:00:00Z'), new Date('2025-01-14T00:00:00Z'));
    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { logDate: 'asc' } }));
  });

  it('reads existing violations for the range', async () => {
    await repo.findViolations('driver-1', new Date('2025-01-14T00:00:00Z'), new Date('2025-01-15T00:00:00Z'));
    expect(prisma.hosViolation.findMany).toHaveBeenCalledWith({
      where: { driverId: 'driver-1', logDate: { gte: new Date('2025-01-14T00:00:00Z'), lte: new Date('2025-01-15T00:00:00Z') } },
    });
  });

  it('upserts on the (driverId, logDate, type) unique key', async () => {
    await repo.upsertViolation({
      driverId: 'driver-1', logDate: new Date('2025-01-14T00:00:00Z'), type: 'DRIVING_11',
      occurredAt: new Date('2025-01-14T20:00:00Z'), exceededBySec: 1560, detail: 'over',
    });
    const args = lastArgs(prisma.hosViolation.upsert);
    expect(args.where).toEqual({ driverId_logDate_type: { driverId: 'driver-1', logDate: new Date('2025-01-14T00:00:00Z'), type: 'DRIVING_11' } });
  });

  it('creates the row OPEN', async () => {
    await repo.upsertViolation({ driverId: 'd', logDate: new Date(0), type: 'BREAK_30', occurredAt: new Date(0), exceededBySec: 1, detail: 'x' });
    expect(lastArgs(prisma.hosViolation.upsert).create.status).toBe('OPEN');
  });

  it('refreshes the measured values on update and bumps recalcVersion', async () => {
    await repo.upsertViolation({ driverId: 'd', logDate: new Date(0), type: 'BREAK_30', occurredAt: new Date(0), exceededBySec: 5, detail: 'x' });
    expect(lastArgs(prisma.hosViolation.upsert).update).toEqual({ occurredAt: new Date(0), exceededBySec: 5, detail: 'x', status: 'OPEN', recalcVersion: { increment: 1 } });
  });

  it('auto-clears rather than deletes', async () => {
    await repo.autoClear('v1');
    expect(prisma.hosViolation.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { status: 'AUTO_CLEARED', recalcVersion: { increment: 1 } } });
  });

  it('refreshes a resolved violation without touching its status', async () => {
    await repo.refreshResolved('v1', 900);
    expect(prisma.hosViolation.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { exceededBySec: 900, recalcVersion: { increment: 1 } } });
  });

  it('flags the daily log when violations exist', async () => {
    prisma.dailyLog.updateMany.mockResolvedValue({ count: 1 });
    await expect(repo.updateDailyLogViolationFlags('driver-1', new Date('2025-01-14T00:00:00Z'), 2)).resolves.toBe(1);
    expect(lastArgs(prisma.dailyLog.updateMany).data).toMatchObject({ hasViolation: true, violationCount: 2 });
  });

  it('clears the flag when the day is clean', async () => {
    prisma.dailyLog.updateMany.mockResolvedValue({ count: 0 });
    await repo.updateDailyLogViolationFlags('driver-1', new Date('2025-01-14T00:00:00Z'), 0);
    expect(lastArgs(prisma.dailyLog.updateMany).data).toMatchObject({ hasViolation: false, violationCount: 0 });
  });
});
