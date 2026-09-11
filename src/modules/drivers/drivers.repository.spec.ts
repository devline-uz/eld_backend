import { DriversRepository } from './drivers.repository';

function makeDelegate() {
  return {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  };
}

describe('DriversRepository', () => {
  let driver: ReturnType<typeof makeDelegate>;
  let repo: DriversRepository;

  beforeEach(() => {
    driver = makeDelegate();
    const prisma = { driver } as never;
    repo = new DriversRepository(prisma);
  });

  it('findByUsername queries by username', async () => {
    await repo.findByUsername('johnsmith');
    expect(driver.findUnique).toHaveBeenCalledWith({ where: { username: 'johnsmith' } });
  });

  it('list builds status/q filters and paginates', async () => {
    driver.findMany.mockResolvedValue([{ id: 'd1' }]);
    driver.count.mockResolvedValue(1);
    const result = await repo.list({ status: 'ACTIVE', q: 'smith' }, 1, 10, { username: 'asc' });
    const where = (driver.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBe('ACTIVE');
    expect(where.OR).toEqual(expect.arrayContaining([{ lastName: { contains: 'smith', mode: 'insensitive' } }]));
    expect(result).toEqual({ items: [{ id: 'd1' }], total: 1 });
  });

  it('list omits optional filters when absent', async () => {
    await repo.list({}, 1, 20, { username: 'asc' });
    const where = (driver.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it('listAll orders by username', async () => {
    await repo.listAll();
    expect(driver.findMany).toHaveBeenCalledWith({ orderBy: { username: 'asc' } });
  });
});
