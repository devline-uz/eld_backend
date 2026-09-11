import { HealthRepository } from './health.repository';

describe('HealthRepository', () => {
  it('pingDatabase delegates to prisma.ping()', async () => {
    const prisma = { ping: jest.fn().mockResolvedValue(true) };
    const repo = new HealthRepository(prisma as never);
    const result = await repo.pingDatabase();
    expect(prisma.ping).toHaveBeenCalled();
    expect(result).toBe(true);
  });
});
