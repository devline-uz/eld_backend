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
  let hosViolation: { groupBy: jest.Mock };
  let repo: DriversRepository;

  beforeEach(() => {
    driver = makeDelegate();
    hosViolation = { groupBy: jest.fn().mockResolvedValue([]) };
    const prisma = { driver, hosViolation } as never;
    repo = new DriversRepository(prisma);
  });

  it('findByUsername queries live (non-deleted) drivers by username', async () => {
    await repo.findByUsername('johnsmith');
    expect(driver.findFirst).toHaveBeenCalledWith({ where: { username: 'johnsmith', deletedAt: null } });
  });

  it('findByEmail queries live (non-deleted) drivers by email, case-insensitively (B-100)', async () => {
    await repo.findByEmail('a@b.co');
    expect(driver.findFirst).toHaveBeenCalledWith({ where: { email: { equals: 'a@b.co', mode: 'insensitive' }, deletedAt: null } });
  });

  it('list builds status/q filters and paginates', async () => {
    driver.findMany.mockResolvedValue([{ id: 'd1' }]);
    driver.count.mockResolvedValue(1);
    const result = await repo.list({ status: 'ACTIVE', q: 'smith' }, 1, 10, { username: 'asc' });
    const where = (driver.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBe('ACTIVE');
    expect(where.deletedAt).toBeNull();
    expect(where.OR).toEqual(expect.arrayContaining([{ lastName: { contains: 'smith', mode: 'insensitive' } }]));
    expect(result).toEqual({ items: [{ id: 'd1' }], total: 1 });
  });

  it('list omits optional filters when absent', async () => {
    await repo.list({}, 1, 20, { username: 'asc' });
    const where = (driver.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where.status).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it('listAll returns live drivers ordered by username', async () => {
    await repo.listAll();
    expect(driver.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, orderBy: { username: 'asc' } });
  });
  describe('listRoster', () => {
    const whereOf = () => (driver.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;

    it('includes the assigned unit and paginates', async () => {
      driver.count.mockResolvedValue(3);
      const result = await repo.listRoster({}, 2, 10, { lastName: 'asc' });
      expect(driver.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        orderBy: { lastName: 'asc' },
        skip: 10,
        take: 10,
        include: { assignedVehicle: { select: { id: true, unitNumber: true } } },
      });
      expect(result.total).toBe(3);
    });

    it('builds the terminal/exempt/q/status filters', async () => {
      await repo.listRoster({ status: 'ACTIVE', terminal: 'Columbus, OH', exempt: false, q: 'smi' }, 1, 25, {});
      const where = whereOf();
      expect(where).toMatchObject({ status: 'ACTIVE', homeTerminalName: { equals: 'Columbus, OH', mode: 'insensitive' }, eldExempt: false });
      expect(where.OR).toEqual(expect.arrayContaining([{ username: { contains: 'smi', mode: 'insensitive' } }]));
    });

    it.each([
      [true, { some: { status: 'OPEN' } }],
      [false, { none: { status: 'OPEN' } }],
    ])('hasOpenViolation=%s filters on OPEN violations', async (flag, expected) => {
      await repo.listRoster({ hasOpenViolation: flag }, 1, 25, {});
      expect(whereOf().violations).toEqual(expected);
    });
  });

  describe('countOpenViolations', () => {
    it('skips the query for no drivers', async () => {
      expect((await repo.countOpenViolations([])).size).toBe(0);
      expect(hosViolation.groupBy).not.toHaveBeenCalled();
    });

    it('groups OPEN violations by driver', async () => {
      hosViolation.groupBy.mockResolvedValue([{ driverId: 'd1', _count: { _all: 2 } }]);
      const counts = await repo.countOpenViolations(['d1', 'd2']);
      expect(hosViolation.groupBy).toHaveBeenCalledWith({ by: ['driverId'], where: { driverId: { in: ['d1', 'd2'] }, status: 'OPEN' }, _count: { _all: true } });
      expect(counts.get('d1')).toBe(2);
      expect(counts.get('d2')).toBeUndefined();
    });
  });
});
