import { Prisma } from '@prisma/client';
import type { WorkOrder } from '@prisma/client';
import type { PrismaService } from '../../core/prisma/prisma.service';
import { holdsUnitOutOfService, nextWorkOrderNumber, syncVehicleOutOfService, WorkOrdersRepository } from './work-orders.repository';

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
    defect: { count: jest.fn(async () => opts.oosDefects ?? 0), updateMany: jest.fn(async () => ({ count: 0 })) },
    $queryRaw: jest.fn(async () => [{ seq: BigInt(41) }]),
    $executeRawUnsafe: jest.fn(async () => 0),
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

  it('QA CODE-008 — counts DEFERRED out-of-service defects as still holding the unit', async () => {
    const { tx } = fakeTx({ status: 'OUT_OF_SERVICE', holds: 0 });
    await syncVehicleOutOfService(tx, 'veh_1', true);
    expect((tx as unknown as { defect: { count: jest.Mock } }).defect.count).toHaveBeenCalledWith({
      where: { vehicleId: 'veh_1', status: { in: ['OPEN', 'IN_PROGRESS', 'DEFERRED'] }, OR: [{ severity: 'CRITICAL' }, { outOfService: true }] },
    });
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
    return { repo: new WorkOrdersRepository(prisma as unknown as PrismaService), prisma, vehicleUpdate, tx: tx as unknown as FakeTxMocks };
  }
  interface FakeTxMocks {
    workOrder: { create: jest.Mock };
    $queryRaw: jest.Mock;
    $executeRawUnsafe: jest.Mock;
    defect: { updateMany: jest.Mock };
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

  it('CODE-078 — updateSynced writes only the row still in the status it was read in', async () => {
    const { repo, tx } = build({ status: 'ACTIVE', holds: 0 });
    await repo.updateSynced(before, { title: 'Brakes' });
    expect((tx as unknown as { workOrder: { update: jest.Mock } }).workOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: before.id, status: before.status } }),
    );
  });

  it('CODE-078 — a write that raced a close is a 409, never a reopened DONE work order', async () => {
    const { repo, tx } = build({ status: 'ACTIVE', holds: 0 });
    (tx as unknown as { workOrder: { update: jest.Mock } }).workOrder.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('No record found', { code: 'P2025', clientVersion: 'test' }),
    );
    await expect(repo.updateSynced(before, { title: 'Brakes' })).rejects.toMatchObject({ code: 'WORK_ORDER_CLOSED' });
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

  it('QA CODE-033 — createSynced numbers the work order and links its defects in the same transaction', async () => {
    const { repo, prisma, tx } = build({ status: 'ACTIVE', holds: 0 });
    const result = await repo.createSynced({ keepOutOfService: false } as Prisma.WorkOrderCreateInput, 'veh_1', ['d1', 'd2']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.workOrder.number).toBe('WO-0042');
    expect(tx.defect.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['d1', 'd2'] } }, data: { workOrderId: 'wo_1' } });
  });

  it('QA CODE-033 — a number collision (P2002 on number) is retried, other errors are not', async () => {
    const { repo, prisma, tx } = build({ status: 'ACTIVE', holds: 0 });
    const collision = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['number'] } });
    tx.workOrder.create.mockRejectedValueOnce(collision);
    await expect(repo.createSynced({} as Prisma.WorkOrderCreateInput, 'veh_1')).resolves.toMatchObject({ workOrder: { id: 'wo_1' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);

    tx.workOrder.create.mockRejectedValueOnce(new Error('boom'));
    await expect(repo.createSynced({} as Prisma.WorkOrderCreateInput, 'veh_1')).rejects.toThrow('boom');
  });

  it('B3-08 — numbers are allocated under a transaction-scoped advisory lock (parallel creates never collide)', async () => {
    const { repo, tx } = build({ status: 'ACTIVE', holds: 0 });
    await repo.createSynced({} as Prisma.WorkOrderCreateInput, 'veh_1');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', 'work-order-number');
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
  });

  it('QA CODE-033 — gives up after repeated collisions', async () => {
    const { repo, prisma, tx } = build({ status: 'ACTIVE', holds: 0 });
    const collision = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: 'WorkOrder_number_key' } });
    tx.workOrder.create.mockRejectedValue(collision);
    await expect(repo.createSynced({} as Prisma.WorkOrderCreateInput, 'veh_1')).rejects.toBe(collision);
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
  });
});

describe('nextWorkOrderNumber', () => {
  it('continues from the highest numeric suffix, padded to 4', async () => {
    await expect(nextWorkOrderNumber({ $queryRaw: jest.fn(async () => [{ seq: BigInt(2214) }]) } as never)).resolves.toBe('WO-2215');
    await expect(nextWorkOrderNumber({ $queryRaw: jest.fn(async () => [{ seq: BigInt(9999) }]) } as never)).resolves.toBe('WO-10000');
  });

  it('starts at WO-0001 on an empty table', async () => {
    await expect(nextWorkOrderNumber({ $queryRaw: jest.fn(async () => [{ seq: null }]) } as never)).resolves.toBe('WO-0001');
  });
});
