import type { Prisma, WorkOrder } from '@prisma/client';
import type { PrismaService } from '../../core/prisma/prisma.service';
import { holdsUnitOutOfService, syncVehicleOutOfService, WorkOrdersRepository } from './work-orders.repository';

/** A minimal transaction client: one vehicle, a count of open flagged work orders and of open
 * out-of-service defects. */
function fakeTx(opts: { status: string | null; holds: number; oosDefects?: number }) {
  const vehicleUpdate = jest.fn(async () => ({}));
  const workOrderCount = jest.fn(async () => opts.holds);
  const tx = {
    vehicle: {
      findUnique: jest.fn(async () => (opts.status ? { status: opts.status } : null)),
      update: vehicleUpdate,
    },
    workOrder: {
      count: workOrderCount,
      create: jest.fn(async ({ data }: { data: object }) => ({ id: 'wo_1', vehicleId: 'veh_1', status: 'OPEN', ...data })),
      update: jest.fn(async ({ data }: { data: object }) => ({ id: 'wo_1', vehicleId: 'veh_1', status: 'OPEN', keepOutOfService: true, ...data })),
    },
    defect: { count: jest.fn(async () => opts.oosDefects ?? 0) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, vehicleUpdate, workOrderCount };
}

describe('syncVehicleOutOfService (work order "Keep the unit out of service")', () => {
  it('puts an ACTIVE unit out of service while an open flagged work order exists', async () => {
    const { tx, vehicleUpdate, workOrderCount } = fakeTx({ status: 'ACTIVE', holds: 1 });
    await expect(syncVehicleOutOfService(tx, 'veh_1', false)).resolves.toBe('OUT_OF_SERVICE');
    expect(workOrderCount).toHaveBeenCalledWith({
      where: { vehicleId: 'veh_1', keepOutOfService: true, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    });
    expect(vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'veh_1' }, data: { status: 'OUT_OF_SERVICE' } });
  });

  it('leaves a unit that is already out of service alone', async () => {
    const { tx, vehicleUpdate } = fakeTx({ status: 'OUT_OF_SERVICE', holds: 2 });
    await expect(syncVehicleOutOfService(tx, 'veh_1', true)).resolves.toBeNull();
    expect(vehicleUpdate).not.toHaveBeenCalled();
  });

  it('never touches an INACTIVE unit', async () => {
    const { tx, vehicleUpdate } = fakeTx({ status: 'INACTIVE', holds: 1 });
    await expect(syncVehicleOutOfService(tx, 'veh_1', false)).resolves.toBeNull();
    expect(vehicleUpdate).not.toHaveBeenCalled();
  });

  it('restores ACTIVE when the last hold is released', async () => {
    const { tx, vehicleUpdate } = fakeTx({ status: 'OUT_OF_SERVICE', holds: 0 });
    await expect(syncVehicleOutOfService(tx, 'veh_1', true)).resolves.toBe('ACTIVE');
    expect(vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'veh_1' }, data: { status: 'ACTIVE' } });
  });

  it('does not restore when no hold was released (unit out of service for another reason)', async () => {
    const { tx, vehicleUpdate } = fakeTx({ status: 'OUT_OF_SERVICE', holds: 0 });
    await expect(syncVehicleOutOfService(tx, 'veh_1', false)).resolves.toBeNull();
    expect(vehicleUpdate).not.toHaveBeenCalled();
  });

  it('does not restore while an open out-of-service DVIR defect remains', async () => {
    const { tx, vehicleUpdate } = fakeTx({ status: 'OUT_OF_SERVICE', holds: 0, oosDefects: 1 });
    await expect(syncVehicleOutOfService(tx, 'veh_1', true)).resolves.toBeNull();
    expect(vehicleUpdate).not.toHaveBeenCalled();
  });
});

describe('holdsUnitOutOfService', () => {
  it.each([
    ['OPEN', true, true],
    ['IN_PROGRESS', true, true],
    ['DONE', true, false],
    ['CANCELLED', true, false],
    ['OPEN', false, false],
  ] as const)('%s + flag %s → %s', (status, keepOutOfService, expected) => {
    expect(holdsUnitOutOfService({ status, keepOutOfService })).toBe(expected);
  });
});

describe('WorkOrdersRepository synced writes run in one transaction', () => {
  function build(opts: { status: string; holds: number }) {
    const { tx, vehicleUpdate } = fakeTx(opts);
    const prisma = { $transaction: jest.fn(async (fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx)) };
    return { repo: new WorkOrdersRepository(prisma as unknown as PrismaService), prisma, vehicleUpdate };
  }
  const before = { id: 'wo_1', vehicleId: 'veh_1', status: 'OPEN', keepOutOfService: true } as WorkOrder;

  it('createSynced inserts and applies the hold inside $transaction', async () => {
    const { repo, prisma, vehicleUpdate } = build({ status: 'ACTIVE', holds: 1 });
    const result = await repo.createSynced({ keepOutOfService: true } as Prisma.WorkOrderCreateInput, 'veh_1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.vehicleStatus).toBe('OUT_OF_SERVICE');
    expect(vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'veh_1' }, data: { status: 'OUT_OF_SERVICE' } });
  });

  it('updateSynced completing the last flagged work order restores ACTIVE', async () => {
    const { repo, vehicleUpdate } = build({ status: 'OUT_OF_SERVICE', holds: 0 });
    const result = await repo.updateSynced(before, { status: 'DONE' });
    expect(result.vehicleStatus).toBe('ACTIVE');
    expect(vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'veh_1' }, data: { status: 'ACTIVE' } });
  });

  it('updateSynced turning the flag off restores ACTIVE when nothing else holds the unit', async () => {
    const { repo } = build({ status: 'OUT_OF_SERVICE', holds: 0 });
    await expect(repo.updateSynced(before, { keepOutOfService: false })).resolves.toMatchObject({ vehicleStatus: 'ACTIVE' });
  });

  it('updateSynced keeps the unit out of service while another flagged work order stays open', async () => {
    const { repo, vehicleUpdate } = build({ status: 'OUT_OF_SERVICE', holds: 1 });
    await expect(repo.updateSynced(before, { status: 'CANCELLED' })).resolves.toMatchObject({ vehicleStatus: null });
    expect(vehicleUpdate).not.toHaveBeenCalled();
  });

  it('updateSynced editing an unflagged work order never restores a unit held for another reason', async () => {
    const { repo, vehicleUpdate } = build({ status: 'OUT_OF_SERVICE', holds: 0 });
    await repo.updateSynced({ ...before, keepOutOfService: false }, { title: 'Brakes' });
    expect(vehicleUpdate).not.toHaveBeenCalled();
  });
});
