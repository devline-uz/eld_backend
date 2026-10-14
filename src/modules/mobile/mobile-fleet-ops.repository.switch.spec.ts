import type { PrismaService } from '../../core/prisma/prisma.service';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';

/** D-155 — the family revoke inside switchSeats is scoped to the outgoing driver's own family. */
describe('MobileFleetOpsRepository.switchSeats — session family revoke (D-155)', () => {
  function build() {
    const tx = {
      driverSession: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      coDriverPairing: { update: jest.fn(), create: jest.fn() },
      driver: { updateMany: jest.fn(), update: jest.fn() },
    };
    const prisma = { $transaction: jest.fn((fn: (t: typeof tx) => Promise<void>) => fn(tx)) };
    return { repo: new MobileFleetOpsRepository(prisma as unknown as PrismaService), tx };
  }
  const base = { pairingId: 'p', endedById: 'd1', now: new Date('2026-10-14T00:00:00Z'), newPrimaryDriverId: 'd2', newCoDriverId: 'd1', vehicleId: 'v' };

  it('revokes only live sessions of that driver in that family; other families/devices and other drivers are not matched', async () => {
    const { repo, tx } = build();
    await repo.switchSeats({ ...base, revokeFamily: { driverId: 'd1', familyId: 'famA' } });
    expect(tx.driverSession.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.driverSession.updateMany).toHaveBeenCalledWith({
      where: { driverId: 'd1', revokedAt: null, OR: [{ familyId: 'famA' }, { id: 'famA' }] },
      data: { revokedAt: base.now },
    });
    expect(tx.coDriverPairing.create).toHaveBeenCalled();
  });

  it('without revokeFamily no session is touched', async () => {
    const { repo, tx } = build();
    await repo.switchSeats(base);
    expect(tx.driverSession.updateMany).not.toHaveBeenCalled();
  });
});
