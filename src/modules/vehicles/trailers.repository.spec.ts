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

  it('findByNumber queries by number', async () => {
    await repo.findByNumber('TR-1');
    expect(trailer.findUnique).toHaveBeenCalledWith({ where: { number: 'TR-1' } });
  });

  it('listAll orders by number', async () => {
    await repo.listAll();
    expect(trailer.findMany).toHaveBeenCalledWith({ orderBy: { number: 'asc' } });
  });
});
