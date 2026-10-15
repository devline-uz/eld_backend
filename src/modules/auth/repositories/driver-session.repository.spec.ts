import { DriverSessionRepository } from './driver-session.repository';

const DEV = '11111111-1111-4111-8111-111111111111';
const future = () => new Date(Date.now() + 60_000);
const row = (over: Record<string, unknown> = {}) => ({
  id: 'old1',
  driverId: 'd1',
  familyId: 'f1',
  deviceId: 'other-dev',
  deviceLabel: 'Galaxy',
  lastMotionAt: null,
  revokedAt: null,
  expiresAt: future(),
  lastSeenAt: new Date(),
  ...over,
});

function build(live: Array<ReturnType<typeof row>>) {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    driverSession: {
      findMany: jest.fn().mockResolvedValueOnce(live).mockResolvedValue([{ id: 'x' }]),
      create: jest.fn().mockResolvedValue({ id: 'new1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { repo: new DriverSessionRepository(prisma as never), tx };
}

const input = { driverId: 'd1', refreshHash: 'h', familyId: 'fnew', deviceId: DEV, deviceLabel: 'Pixel', expiresAt: future() };

describe('DriverSessionRepository.createExclusive (MD-195, B-174/B-175)', () => {
  it('takes the per-driver advisory lock before reading, so concurrent logins / rotations serialise', async () => {
    const { repo, tx } = build([]);
    await repo.createExclusive(input, 120_000);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), 'driver-session:d1');
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(tx.driverSession.findMany.mock.invocationCallOrder[0]);
  });

  it('another device moving within the window -> moving, nothing created or revoked', async () => {
    const { repo, tx } = build([row({ lastMotionAt: new Date(Date.now() - 10_000) })]);
    const r = await repo.createExclusive(input, 120_000);
    expect(r.kind).toBe('moving');
    expect(tx.driverSession.create).not.toHaveBeenCalled();
    expect(tx.driverSession.updateMany).not.toHaveBeenCalled();
  });

  it('motion on the SAME deviceId does not block (a device cannot be "another device")', async () => {
    const { repo } = build([row({ deviceId: DEV, lastMotionAt: new Date() })]);
    await expect(repo.createExclusive(input, 120_000)).resolves.toMatchObject({ kind: 'created' });
  });

  it('revokes every live family (other device AND same deviceId) as REPLACED, whole family, once per family', async () => {
    const { repo, tx } = build([row(), row({ id: 'old2', familyId: 'f1' }), row({ id: 'same1', familyId: 'f2', deviceId: DEV })]);
    const r = await repo.createExclusive(input, 120_000);
    expect(r).toMatchObject({ kind: 'created', session: { id: 'new1' } });
    if (r.kind !== 'created') throw new Error('unreachable');
    expect(r.replaced.map((x) => x.session.id)).toEqual(['old1', 'same1']);
    expect(tx.driverSession.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.driverSession.updateMany).toHaveBeenCalledWith({
      where: { driverId: 'd1', revokedAt: null, OR: [{ familyId: 'f1' }, { id: 'f1' }] },
      data: expect.objectContaining({ revokedReason: 'REPLACED', replacedByDeviceId: DEV, replacedByDeviceLabel: 'Pixel' }) as unknown,
    });
  });
});

describe('DriverSessionRepository.rotate', () => {
  it('B-174: takes the same per-driver lock as the takeover', async () => {
    const tx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      driverSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), create: jest.fn().mockResolvedValue({ id: 's2' }) },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    await new DriverSessionRepository(prisma as never).rotate('s1', { driverId: 'd1', refreshHash: 'h', expiresAt: future() });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), 'driver-session:d1');
  });
});
