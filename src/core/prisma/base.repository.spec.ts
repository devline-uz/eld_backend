import { BaseRepository, ModelDelegate } from './base.repository';
import { RequestContext } from '../context/request-context';

interface Row {
  id: string;
  name: string;
}

class TestRepository extends BaseRepository<Row> {
  constructor(private readonly delegate: ModelDelegate<Row, Record<string, unknown>, { id: string }, Record<string, unknown>, Record<string, unknown>>) {
    super({} as never);
  }

  protected get model() {
    return this.delegate;
  }
}

function makeDelegate(): ModelDelegate<Row, Record<string, unknown>, { id: string }, Record<string, unknown>, Record<string, unknown>> {
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

describe('BaseRepository', () => {
  let delegate: ReturnType<typeof makeDelegate>;
  let repo: TestRepository;

  beforeEach(() => {
    delegate = makeDelegate();
    repo = new TestRepository(delegate);
  });

  it('findById delegates to findUnique', async () => {
    delegate.findUnique = jest.fn().mockResolvedValue({ id: 'r1', name: 'x' });
    const result = await repo.findById({ id: 'r1' });
    expect(delegate.findUnique).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(result).toEqual({ id: 'r1', name: 'x' });
  });

  it('findOne delegates to findFirst with scoped where', async () => {
    await repo.findOne({ name: 'x' });
    expect(delegate.findFirst).toHaveBeenCalledWith({ where: { name: 'x' } });
  });

  it('findMany delegates to findMany with where/take/orderBy', async () => {
    await repo.findMany({ name: 'x' }, 10, { name: 'asc' });
    expect(delegate.findMany).toHaveBeenCalledWith({ where: { name: 'x' }, take: 10, orderBy: { name: 'asc' } });
  });

  it('count delegates to count with scoped where', async () => {
    await repo.count({ name: 'x' });
    expect(delegate.count).toHaveBeenCalledWith({ where: { name: 'x' } });
  });

  it('create delegates to create', async () => {
    await repo.create({ name: 'new' });
    expect(delegate.create).toHaveBeenCalledWith({ data: { name: 'new' } });
  });

  it('update delegates to update', async () => {
    await repo.update({ id: 'r1' }, { name: 'updated' });
    expect(delegate.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { name: 'updated' } });
  });

  it('delete delegates to delete', async () => {
    await repo.delete({ id: 'r1' });
    expect(delegate.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });

  it('carrierId reads from RequestContext, undefined outside a bound run()', () => {
    expect((repo as unknown as { carrierId?: string }).carrierId).toBeUndefined();
  });

  describe('paginate', () => {
    it('returns nextCursor null when there is no extra row beyond the limit', async () => {
      delegate.findMany = jest.fn().mockResolvedValue([{ id: 'r1', name: 'a' }, { id: 'r2', name: 'b' }]);
      const page = await repo.paginate(undefined, 2);
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 3, skip: 0, cursor: undefined }),
      );
    });

    it('slices to limit and returns nextCursor from the default id field when there is an extra row', async () => {
      delegate.findMany = jest.fn().mockResolvedValue([
        { id: 'r1', name: 'a' },
        { id: 'r2', name: 'b' },
        { id: 'r3', name: 'c' },
      ]);
      const page = await repo.paginate(undefined, 2);
      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBe('r2');
    });

    it('passes cursor/orderBy/cursorField through to findMany and reads the given cursorField', async () => {
      delegate.findMany = jest.fn().mockResolvedValue([
        { id: 'r1', name: 'a', seq: 1 },
        { id: 'r2', name: 'b', seq: 2 },
      ]);
      const page = await repo.paginate({ name: 'x' }, 1, 'r0', { seq: 'asc' }, 'seq');
      expect(delegate.findMany).toHaveBeenCalledWith({
        where: { name: 'x' },
        take: 2,
        skip: 1,
        cursor: { seq: 'r0' },
        orderBy: { seq: 'asc' },
      });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBe('1');
    });
  });
});

describe('BaseRepository.carrierId with a bound RequestContext', () => {
  it('reads carrierId from the ambient RequestContext', () => {
    const delegate = makeDelegate();
    const repo = new TestRepository(delegate);
    RequestContext.run({ requestId: 'r', traceId: 't', carrierId: 'carrier-9', startedAt: Date.now() }, () => {
      expect((repo as unknown as { carrierId?: string }).carrierId).toBe('carrier-9');
    });
  });
});
