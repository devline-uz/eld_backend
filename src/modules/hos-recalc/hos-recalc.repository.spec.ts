/** TZ §8.4 — the violation write rules at the Prisma boundary. */
import { HosRecalcRepository } from './hos-recalc.repository';
import type { PrismaService } from '../../core/prisma/prisma.service';

describe('HosRecalcRepository', () => {
  const prisma = {
    driver: { findUnique: jest.fn() },
    eldEvent: { findMany: jest.fn() },
    dailyLog: { findMany: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
    unidentifiedSegment: { findMany: jest.fn() },
    hosViolation: { findMany: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    $queryRaw: jest.fn(),
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

  it('B-059: reads RODS records of every status (markers retire superseded records), in order', async () => {
    const from = new Date('2025-01-05T00:00:00Z');
    const to = new Date('2025-01-14T00:00:00Z');
    await repo.findRodsEvents('driver-1', from, to);
    const args = lastArgs(prisma.eldEvent.findMany);
    expect(args.where).toEqual({ driverId: 'driver-1', eventDateTime: { gte: from, lte: to } });
    expect(args.orderBy).toEqual([{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }]);
    expect(args.select).toMatchObject({ recordStatus: true, recordOrigin: true, supersedesId: true, totalVehicleMiles: true, vehicleId: true });
  });

  it('B-059: reads only unresolved (PENDING / B-83 PENDING_CONFIRMATION) segments on the given units, and nothing without units', async () => {
    expect(await repo.findUnidentifiedSegments([], new Date(), new Date())).toEqual([]);
    expect(prisma.unidentifiedSegment.findMany).not.toHaveBeenCalled();
    const from = new Date('2025-01-05T00:00:00Z');
    const to = new Date('2025-01-14T00:00:00Z');
    await repo.findUnidentifiedSegments(['veh-1'], from, to);
    expect(lastArgs(prisma.unidentifiedSegment.findMany).where).toEqual({
      vehicleId: { in: ['veh-1'] },
      status: { in: ['PENDING', 'PENDING_CONFIRMATION'] },
      startAt: { lte: to },
      endAt: { gte: from },
    });
  });

  it('B-059: upserts header totals on (driverId, logDate) and never a certification column', async () => {
    const logDate = new Date('2025-01-14T00:00:00Z');
    await repo.upsertDailyLogTotals({
      driverId: 'driver-1', logDate, timezone: 'America/New_York', offDutySec: 1, sleeperSec: 2, drivingSec: 3, onDutySec: 4,
      totalDistanceMi: 5, hasUnassigned: false, hasEdits: true,
    });
    const args = lastArgs(prisma.dailyLog.upsert);
    expect(args.where).toEqual({ driverId_logDate: { driverId: 'driver-1', logDate } });
    for (const part of [args.create, args.update]) {
      expect(Object.keys(part).some((k) => k.startsWith('certif') || k === 'signatureUrl')).toBe(false);
    }
    expect(args.update).toMatchObject({ onDutySec: 4, drivingSec: 3, hasEdits: true, recalcVersion: { increment: 1 } });
  });

  it('reads the daily log history in date order', async () => {
    await repo.findDailyLogs('driver-1', new Date('2025-01-05T00:00:00Z'), new Date('2025-01-14T00:00:00Z'));
    expect(prisma.dailyLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { logDate: 'asc' } }));
  });

  it('B-055: the batched event read issues no query for no windows', async () => {
    await expect(repo.findEventsForDrivers([], new Date(), 10)).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('B-055: the batched event read applies a per-driver window, slim columns and a per-driver LIMIT', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    const to = new Date('2025-01-15T03:00:00Z');
    await repo.findEventsForDrivers(
      [{ driverId: 'a', from: new Date('2025-01-05T05:00:00Z') }, { driverId: 'b', from: new Date('2025-01-05T08:00:00Z') }],
      to,
      2001,
    );
    const sql = (prisma.$queryRaw.mock.calls[0] as unknown[])[0] as { sql: string; values: unknown[] };
    expect(sql.sql).toContain('unnest(');
    expect(sql.sql).toContain('CROSS JOIN LATERAL');
    expect(sql.sql).toMatch(/"eventType" IN \(1, 3\)/);
    expect(sql.sql).toMatch(/LIMIT \?::int/);
    expect(sql.sql).not.toMatch(/SELECT \*/);
    expect(sql.values).toEqual([['a', 'b'], ['2025-01-05T05:00:00.000Z', '2025-01-05T08:00:00.000Z'], to, 2001]);
  });

  it('B-055: the batched daily-log read selects only the recap columns', async () => {
    await repo.findDailyLogsForDrivers(['a'], new Date('2025-01-05T00:00:00Z'), new Date('2025-01-14T00:00:00Z'));
    expect(lastArgs(prisma.dailyLog.findMany).select).toEqual({ driverId: true, logDate: true, onDutySec: true, drivingSec: true });
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
