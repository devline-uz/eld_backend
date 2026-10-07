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

  it('findByNumber only matches live (not soft-deleted) trailers', async () => {
    await repo.findByNumber('TR-1');
    expect(trailer.findFirst).toHaveBeenCalledWith({ where: { number: 'TR-1', deletedAt: null } });
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
