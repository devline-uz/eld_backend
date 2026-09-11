/** TZ §8.6 — the `DriverHosSnapshot` write rules at the Prisma boundary. */
import { HosStateRepository } from './hos-state.repository';
import type { PrismaService } from '../../core/prisma/prisma.service';

describe('HosStateRepository', () => {
  const prisma = {
    driverHosSnapshot: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  };
  const repo = new HosStateRepository(prisma as unknown as PrismaService);
  const lastArgs = (mock: jest.Mock): Record<string, Record<string, unknown>> => {
    const calls = mock.mock.calls as unknown[][];
    return calls[calls.length - 1][0] as Record<string, Record<string, unknown>>;
  };

  beforeEach(() => jest.clearAllMocks());

  it('reads the snapshot by driver id', async () => {
    await repo.findSnapshot('driver-1');
    expect(prisma.driverHosSnapshot.findUnique).toHaveBeenCalledWith({ where: { driverId: 'driver-1' } });
  });

  it('upserts on the driver primary key — one row per driver, never a history', async () => {
    const computedAt = new Date('2026-03-10T15:41:00Z');
    await repo.upsertSnapshot({
      driverId: 'driver-1',
      computedAt,
      hosEngineVersion: '1.0.0',
      appPlatform: 'IOS',
      state: { currentStatus: 'ON' },
    });
    const args = lastArgs(prisma.driverHosSnapshot.upsert);
    expect(args.where).toEqual({ driverId: 'driver-1' });
    expect(args.create).toMatchObject({ driverId: 'driver-1', hosEngineVersion: '1.0.0', appPlatform: 'IOS' });
    expect(args.update).toMatchObject({ computedAt, hosEngineVersion: '1.0.0' });
  });

  it('clears the previous comparison when a new state arrives', async () => {
    await repo.upsertSnapshot({
      driverId: 'driver-1',
      computedAt: new Date(),
      hosEngineVersion: '1.0.0',
      state: {},
    });
    const args = lastArgs(prisma.driverHosSnapshot.upsert);
    expect(args.update).toMatchObject({ lastComparedAt: null, maxDriftSec: null, appPlatform: null });
  });

  it('records a comparison result', async () => {
    const at = new Date('2026-03-11T03:20:00Z');
    await repo.recordComparison('driver-1', { lastComparedAt: at, maxDriftSec: 900, driftAlerted: true });
    expect(prisma.driverHosSnapshot.update).toHaveBeenCalledWith({
      where: { driverId: 'driver-1' },
      data: { lastComparedAt: at, maxDriftSec: 900, driftAlerted: true },
    });
  });

  it('pages with a keyset cursor in primary-key order', async () => {
    await repo.listSnapshots(null, 200);
    expect(lastArgs(prisma.driverHosSnapshot.findMany)).toEqual({ where: undefined, orderBy: { driverId: 'asc' }, take: 200 });
    await repo.listSnapshots('driver-1', 200);
    expect(lastArgs(prisma.driverHosSnapshot.findMany)).toMatchObject({ where: { driverId: { gt: 'driver-1' } } });
  });
});
