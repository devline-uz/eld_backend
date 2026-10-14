import { DriversRepository, sortRosterKeys } from './drivers.repository';

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

    it('includes the assigned unit and paginates (non-text sort stays in SQL)', async () => {
      driver.count.mockResolvedValue(3);
      const result = await repo.listRoster({}, 2, 10, { registeredAt: 'asc' });
      expect(driver.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        orderBy: { registeredAt: 'asc' },
        skip: 10,
        take: 10,
        include: { assignedVehicle: { select: { id: true, unitNumber: true } } },
      });
      expect(result.total).toBe(3);
    });

    it('LIVE-023 — a name sort ignores case, then loads only the requested page in that order', async () => {
      const key = (id: string, firstName: string, lastName: string) => ({ id, firstName, lastName, username: id, cdlNumber: null, homeTerminalName: null });
      driver.findMany
        .mockResolvedValueOnce([key('d1', 'Ann', 'Young'), key('d2', 'co-driver', 'test'), key('d3', 'Bob', 'adams'), key('d4', 'Cy', 'Brown')])
        .mockResolvedValueOnce([{ id: 'd2' }, { id: 'd1' }]);
      const result = await repo.listRoster({}, 2, 2, { lastName: 'asc' });
      expect(driver.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { deletedAt: null }, select: expect.objectContaining({ id: true, lastName: true }) as object }));
      expect(driver.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { id: { in: ['d2', 'd1'] } } }));
      expect(result.items.map((d) => d.id)).toEqual(['d2', 'd1']);
      expect(result.total).toBe(4);
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

    it.each([
      [true, 'some'],
      [false, 'none'],
    ] as const)('UI-015 — hasOpenViolation=%s applies the stale-cap exclusions (%s)', async (flag, key) => {
      const exclude = [{ NOT: { driverId: 'd1', occurredAt: { gt: new Date('2026-10-11T02:00:00Z') } } }];
      await repo.listRoster({ hasOpenViolation: flag, violationExclude: exclude }, 1, 25, {});
      expect(whereOf().violations).toEqual({ [key]: { AND: [{ status: 'OPEN' }, ...exclude] } });
    });
  });

  describe('rosterSummary (UI-015)', () => {
    it('counts every live driver and those with an active violation, ignoring list filters', async () => {
      driver.count.mockResolvedValueOnce(12).mockResolvedValueOnce(3);
      const exclude = [{ NOT: { driverId: 'd1', occurredAt: { gt: new Date('2026-10-11T02:00:00Z') } } }];
      await expect(repo.rosterSummary(exclude)).resolves.toEqual({ total: 12, withActiveViolations: 3 });
      expect(driver.count).toHaveBeenNthCalledWith(1, { where: { deletedAt: null } });
      expect(driver.count).toHaveBeenNthCalledWith(2, { where: { deletedAt: null, violations: { some: { AND: [{ status: 'OPEN' }, ...exclude] } } } });
    });

    it('without exclusions counts plain OPEN rows', async () => {
      await repo.rosterSummary();
      expect(driver.count).toHaveBeenNthCalledWith(2, { where: { deletedAt: null, violations: { some: { status: 'OPEN' } } } });
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
  describe('sortRosterKeys (LIVE-023)', () => {
    const k = (id: string, firstName: string, lastName: string | null) => ({ id, firstName, lastName, username: id, cdlNumber: null, homeTerminalName: null });
    const rows = [k('a', 'Ann', 'Young'), k('b', 'co-driver', 'test'), k('c', 'test102', 'test102'), k('d', 'Bo', 'test10'), k('e', 'Zed', null)];

    it('orders case-insensitively and number-aware, empty last', () => {
      expect(sortRosterKeys(rows, 'lastName', 'asc').map((r) => r.lastName)).toEqual(['test', 'test10', 'test102', 'Young', null]);
    });

    it('descending keeps empty values last', () => {
      expect(sortRosterKeys(rows, 'lastName', 'desc').map((r) => r.lastName)).toEqual(['Young', 'test102', 'test10', 'test', null]);
    });

    it('breaks ties on the first name', () => {
      const tie = [k('x', 'bob', 'Smith'), k('y', 'Al', 'smith')];
      expect(sortRosterKeys(tie, 'lastName', 'asc').map((r) => r.id)).toEqual(['y', 'x']);
    });
  });

  describe('softDeleteUnlessOnTrip (CODE-062)', () => {
    function lockedRepo(openTrips: Array<{ id: string; number: string; status: string }>) {
      const calls: string[] = [];
      const tx = {
        $executeRawUnsafe: jest.fn(async (_sql: string, key: string) => {
          calls.push(`lock:${key}`);
          return 1;
        }),
        trip: { findMany: jest.fn(async () => (calls.push('check'), openTrips)) },
        driver: { update: jest.fn(async () => (calls.push('delete'), { id: 'd1', status: 'TERMINATED' })) },
      };
      const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as never;
      return { repo: new DriversRepository(prisma), tx, calls };
    }

    it('takes the trip writers\' per-driver lock, re-checks open trips, then soft-deletes — in one transaction', async () => {
      const { repo: locked, tx, calls } = lockedRepo([]);
      const result = await locked.softDeleteUnlessOnTrip('d1');
      expect(calls).toEqual(['lock:trip-driver:d1', 'check', 'delete']);
      expect(tx.driver.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: expect.objectContaining({ status: 'TERMINATED', deletedAt: expect.any(Date) as Date, assignedVehicle: { disconnect: true } }) as object,
      });
      expect(result.deleted).toEqual({ id: 'd1', status: 'TERMINATED' });
    });

    it('returns the open trips and deletes nothing when a trip got in first', async () => {
      const { repo: locked, tx } = lockedRepo([{ id: 't1', number: 'TR-1', status: 'ASSIGNED' }]);
      const result = await locked.softDeleteUnlessOnTrip('d1');
      expect(result.openTrips).toEqual([{ id: 't1', number: 'TR-1', status: 'ASSIGNED' }]);
      expect(tx.driver.update).not.toHaveBeenCalled();
    });
  });
});
