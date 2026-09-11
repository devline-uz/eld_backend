/**
 * §13.6 — the offline-sync idempotency ledger is per driver.
 *
 * `SyncedChange.clientId` is unique table-wide and its value is chosen by the mobile client,
 * so looking a change up by `clientId` alone let driver A claim an arbitrary key and have
 * driver B's genuine queued change treated as "already processed" (silently dropping an HOS
 * mutation) while also handing A the outcome of B's change. The stored key is namespaced.
 */
import { MobileRepository, syncLedgerKey } from './mobile.repository';
import type { PrismaService } from '../../core/prisma/prisma.service';

function build() {
  type CreateArgs = { data: Record<string, unknown> };
  type FindFirstArgs = { where: { OR: Array<Record<string, unknown>> } };
  const syncedChange = {
    findFirst: jest.fn<Promise<null>, [FindFirstArgs]>().mockResolvedValue(null),
    create: jest
      .fn<Promise<Record<string, unknown>>, [CreateArgs]>()
      .mockImplementation(({ data }) => Promise.resolve({ ...data, errorCode: data.errorCode ?? null })),
  };
  const prisma = { syncedChange } as unknown as PrismaService;
  return { repo: new MobileRepository(prisma), syncedChange };
}

describe('sync ledger keys', () => {
  it('namespaces the client-chosen key with the driver id', () => {
    expect(syncLedgerKey('drv_1', 'client-1')).toBe('drv_1:client-1');
    expect(syncLedgerKey('drv_2', 'client-1')).not.toBe(syncLedgerKey('drv_1', 'client-1'));
  });

  it('writes the namespaced key, so two drivers may reuse the same clientId', async () => {
    const { repo, syncedChange } = build();
    await repo.recordSyncedResult('drv_1', 'client-1', 'duty_status', new Date(0), 'ACCEPTED', null, undefined);
    const { data } = syncedChange.create.mock.calls[0][0];
    expect(data.driverId).toBe('drv_1');
    expect(data.clientId).toBe('drv_1:client-1');
  });

  it('only ever matches a ledger row that belongs to the syncing driver', async () => {
    const { repo, syncedChange } = build();
    await repo.findSyncedByClientId('drv_1', 'client-1');
    expect(syncedChange.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ clientId: 'drv_1:client-1' }, { clientId: 'client-1', driverId: 'drv_1' }],
      },
    });
    // Neither branch can match a row written by another driver.
    const { where } = syncedChange.findFirst.mock.calls[0][0];
    expect(where.OR.every((clause) => JSON.stringify(clause).includes('drv_1'))).toBe(true);
  });
});
