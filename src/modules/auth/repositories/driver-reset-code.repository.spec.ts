import { DriverResetCodeRepository, RESET_MAX_CODES_PER_WINDOW } from './driver-reset-code.repository';

/** B-160 — the per-driver daily budget gates code issuance and locks after 15 failures. */
describe('DriverResetCodeRepository throttle (B-160)', () => {
  function build(over: { capHit?: boolean; failedAttempts?: number } = {}) {
    const prisma = {
      driverPasswordResetCode: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ driverId: 'd1' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      driverPasswordResetThrottle: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: over.capHit ? 0 : 1 }),
        update: jest.fn().mockResolvedValue({ failedAttempts: over.failedAttempts ?? 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    return { prisma, repo: new DriverResetCodeRepository(prisma as never) };
  }

  it('issues a code while under the daily cap (cap is a conditional atomic increment)', async () => {
    const { prisma, repo } = build();
    expect(await repo.upsert('d1', 's', 'h', new Date(Date.now() + 60_000))).not.toBeNull();
    const reserve = (prisma.driverPasswordResetThrottle.updateMany.mock.calls as unknown[][]).at(-1)?.[0] as { where: { codesIssued: { lt: number } } };
    expect(reserve.where.codesIssued).toEqual({ lt: RESET_MAX_CODES_PER_WINDOW });
  });

  it('stores nothing (so mails nothing) once the cap is reached or the driver is locked', async () => {
    const { prisma, repo } = build({ capHit: true });
    expect(await repo.upsert('d1', 's', 'h', new Date(Date.now() + 60_000))).toBeNull();
    expect(prisma.driverPasswordResetCode.upsert).not.toHaveBeenCalled();
  });

  it('the 15th failure locks reset for 24 h and deletes the live code', async () => {
    const { prisma, repo } = build({ failedAttempts: 15 });
    const now = new Date();
    expect(await repo.recordFailure('d1', now)).toBe(true);
    const lock = (prisma.driverPasswordResetThrottle.updateMany.mock.calls as unknown[][]).at(-1)?.[0] as { data: { lockedUntil: Date } };
    expect(lock.data.lockedUntil.getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
    expect(prisma.driverPasswordResetCode.deleteMany).toHaveBeenCalledWith({ where: { driverId: 'd1' } });
  });

  it('below 15 failures nothing is locked', async () => {
    const { prisma, repo } = build({ failedAttempts: 14 });
    expect(await repo.recordFailure('d1', new Date())).toBe(false);
    expect(prisma.driverPasswordResetCode.deleteMany).not.toHaveBeenCalled();
  });

  it('isLocked reflects a future lockedUntil only', async () => {
    const { prisma, repo } = build();
    prisma.driverPasswordResetThrottle.findUnique.mockResolvedValueOnce({ lockedUntil: new Date(Date.now() + 1000) });
    expect(await repo.isLocked('d1', new Date())).toBe(true);
    prisma.driverPasswordResetThrottle.findUnique.mockResolvedValueOnce({ lockedUntil: new Date(Date.now() - 1000) });
    expect(await repo.isLocked('d1', new Date())).toBe(false);
  });
});
