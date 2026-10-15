import { TrailersRepository } from './trailers.repository';

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

describe('TrailersRepository', () => {
  let trailer: ReturnType<typeof makeDelegate>;
  let repo: TrailersRepository;

  beforeEach(() => {
    trailer = makeDelegate();
    repo = new TrailersRepository({ trailer } as never);
  });

  it('findByNumber only matches live (not soft-deleted) trailers, trimmed and case-insensitively (BE-07)', async () => {
    await repo.findByNumber(' tr-1 ');
    expect(trailer.findFirst).toHaveBeenCalledWith({ where: { number: { equals: 'tr-1', mode: 'insensitive' }, deletedAt: null } });
  });

  it('BE-07 — findByNumber is literal: `TR_1` / `%` never match another trailer', async () => {
    await repo.findByNumber('TR_1%');
    expect(trailer.findFirst).toHaveBeenCalledWith({ where: { number: { equals: 'TR\\_1\\%', mode: 'insensitive' }, deletedAt: null } });
  });

  it('listAll (export) excludes soft-deleted trailers and orders by number', async () => {
    await repo.listAll();
    expect(trailer.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, orderBy: { number: 'asc' } });
  });

  describe('list', () => {
    it('pages live trailers with no filters', async () => {
      trailer.findMany.mockResolvedValue([{ id: 'tr_1' }]);
      trailer.count.mockResolvedValue(31);
      const result = await repo.list({}, 2, 10, { number: 'asc' });
      expect(trailer.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, orderBy: { number: 'asc' }, skip: 10, take: 10 });
      expect(trailer.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
      expect(result).toEqual({ items: [{ id: 'tr_1' }], total: 31 });
    });

    it('applies status and a case-insensitive q over number / VIN', async () => {
      await repo.list({ q: 'T-4', status: 'OUT_OF_SERVICE' }, 1, 25, { vin: 'desc' });
      const where = {
        deletedAt: null,
        status: 'OUT_OF_SERVICE',
        OR: [
          { number: { contains: 'T-4', mode: 'insensitive' } },
          { vin: { contains: 'T-4', mode: 'insensitive' } },
        ],
      };
      expect(trailer.findMany).toHaveBeenCalledWith({ where, orderBy: { vin: 'desc' }, skip: 0, take: 25 });
      expect(trailer.count).toHaveBeenCalledWith({ where });
    });
  });
});

describe('TrailersRepository.updateUnlessBooked — BE-06', () => {
  function setup(openTrips: Array<{ id: string; number: string; status: string }>) {
    const tx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      trip: { findMany: jest.fn().mockResolvedValue(openTrips) },
      trailer: { update: jest.fn().mockResolvedValue({ id: 'tr_1', status: 'INACTIVE' }) },
    };
    const prisma = { trailer: {}, $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) };
    return { tx, repo: new TrailersRepository(prisma as never) };
  }

  it('takes the trailer trip-schedule lock, then refuses while open trips hold the trailer', async () => {
    const openTrips = [{ id: 'trp_1', number: 'TRP-1', status: 'ASSIGNED' }];
    const { tx, repo } = setup(openTrips);
    await expect(repo.updateUnlessBooked('tr_1', { status: 'OUT_OF_SERVICE' })).resolves.toEqual({ updated: null, openTrips });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), 'trip-trailer:tr_1');
    expect(tx.trip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { trailerId: 'tr_1', status: { in: ['DRAFT', 'PLANNED', 'ASSIGNED', 'IN_PROGRESS'] } },
    }));
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(tx.trip.findMany.mock.invocationCallOrder[0]);
    expect(tx.trailer.update).not.toHaveBeenCalled();
  });

  it('writes inside the same transaction when no open trip holds the trailer', async () => {
    const { tx, repo } = setup([]);
    const result = await repo.updateUnlessBooked('tr_1', { status: 'INACTIVE' });
    expect(tx.trailer.update).toHaveBeenCalledWith({ where: { id: 'tr_1' }, data: { status: 'INACTIVE' } });
    expect(result).toEqual({ updated: { id: 'tr_1', status: 'INACTIVE' }, openTrips: [] });
  });
});
