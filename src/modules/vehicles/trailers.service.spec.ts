import { AppException } from '../../common/errors/app.exception';
import { TrailersRepository } from './trailers.repository';
import { TrailersService } from './trailers.service';

function makeTrailer(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'tr_1', number: 'TR-1', vin: 'VIN1', status: 'ACTIVE', ...overrides };
}

describe('TrailersService', () => {
  let repo: jest.Mocked<Pick<TrailersRepository, 'list' | 'listAll' | 'findById' | 'findByNumber' | 'create' | 'update' | 'delete'>>;
  let service: TrailersService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      listAll: jest.fn(),
      findById: jest.fn(),
      findByNumber: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    service = new TrailersService(repo as unknown as TrailersRepository);
  });

  describe('list', () => {
    it('returns the GET /vehicles offset-page envelope', async () => {
      repo.list.mockResolvedValue({ items: [makeTrailer()], total: 51 } as never);
      const result = await service.list({ page: 2, limit: 25 });
      expect(repo.list).toHaveBeenCalledWith({ q: undefined, status: undefined }, 2, 25, { number: 'asc' });
      expect(result).toEqual({ items: [makeTrailer()], page: 2, limit: 25, total: 51, totalPages: 3 });
    });

    it('forwards q / status and an allowed sort; unknown sort falls back to number:asc', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0 });
      await service.list({ page: 1, limit: 10, q: 'T-1', status: 'INACTIVE', sort: 'vin:desc' });
      expect(repo.list).toHaveBeenLastCalledWith({ q: 'T-1', status: 'INACTIVE' }, 1, 10, { vin: 'desc' });
      await service.list({ page: 1, limit: 10, sort: 'deletedAt:desc' });
      expect(repo.list).toHaveBeenLastCalledWith({ q: undefined, status: undefined }, 1, 10, { number: 'asc' });
    });

    it('an empty result still reports totalPages 1', async () => {
      repo.list.mockResolvedValue({ items: [], total: 0 });
      expect(await service.list({ page: 1, limit: 25 })).toEqual({ items: [], page: 1, limit: 25, total: 0, totalPages: 1 });
    });
  });

  it('get throws notFound when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toThrow(AppException);
  });

  it('get treats a soft-deleted trailer as not found', async () => {
    repo.findById.mockResolvedValue(makeTrailer({ deletedAt: new Date() }) as never);
    await expect(service.get('tr_1')).rejects.toMatchObject({ status: 404 });
  });

  it('get returns the trailer', async () => {
    repo.findById.mockResolvedValue(makeTrailer() as never);
    const result = await service.get('tr_1');
    expect(result.id).toBe('tr_1');
  });

  describe('create', () => {
    it('throws conflict on duplicate number', async () => {
      repo.findByNumber.mockResolvedValue(makeTrailer() as never);
      await expect(service.create({ number: 'TR-1', vin: 'VIN1' })).rejects.toThrow(AppException);
    });

    it('maps a P2002 race on the live-number index to a 409', async () => {
      repo.findByNumber.mockResolvedValue(null);
      repo.create.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
      await expect(service.create({ number: 'TR-1' })).rejects.toMatchObject({ status: 409 });
    });

    it('reuses the number of a soft-deleted trailer (findByNumber only sees live rows)', async () => {
      // The deleted TR-1 is invisible to the live-only lookup, so the create goes through.
      repo.findByNumber.mockResolvedValue(null);
      repo.create.mockResolvedValue(makeTrailer({ id: 'tr_2' }) as never);
      const result = await service.create({ number: 'TR-1' });
      expect(repo.create).toHaveBeenCalledWith({ number: 'TR-1', vin: undefined });
      expect(result.id).toBe('tr_2');
    });

    it('creates when unique', async () => {
      repo.findByNumber.mockResolvedValue(null);
      repo.create.mockResolvedValue(makeTrailer() as never);
      const result = await service.create({ number: 'TR-1', vin: 'VIN1' });
      expect(result.id).toBe('tr_1');
    });
  });

  describe('update', () => {
    it('throws when trailer missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('missing', {})).rejects.toThrow(AppException);
    });

    it('404s on a soft-deleted trailer', async () => {
      repo.findById.mockResolvedValue(makeTrailer({ deletedAt: new Date() }) as never);
      await expect(service.update('tr_1', { vin: 'X' })).rejects.toMatchObject({ status: 404 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('409s when renaming onto another live trailer number', async () => {
      repo.findById.mockResolvedValue(makeTrailer() as never);
      repo.findByNumber.mockResolvedValue(makeTrailer({ id: 'tr_9', number: 'TR-2' }) as never);
      await expect(service.update('tr_1', { number: 'TR-2' })).rejects.toMatchObject({ status: 409 });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('builds a partial update from defined fields', async () => {
      repo.findById.mockResolvedValue(makeTrailer() as never);
      repo.update.mockResolvedValue(makeTrailer({ number: 'TR-2' }) as never);
      await service.update('tr_1', { number: 'TR-2', status: 'ACTIVE' } as never);
      expect(repo.update).toHaveBeenCalledWith({ id: 'tr_1' }, { number: 'TR-2', status: 'ACTIVE' });
    });
  });

  describe('remove', () => {
    it('throws when trailer missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toThrow(AppException);
    });

    it('soft-deletes (stamps deletedAt, never a hard delete)', async () => {
      repo.findById.mockResolvedValue(makeTrailer() as never);
      repo.update.mockResolvedValue(makeTrailer({ deletedAt: new Date() }) as never);
      await service.remove('tr_1');
      const [where, data] = repo.update.mock.calls[0] as [unknown, { status: string; deletedAt: Date }];
      expect(where).toEqual({ id: 'tr_1' });
      expect(data.status).toBe('INACTIVE');
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('404s when the trailer is already deleted', async () => {
      repo.findById.mockResolvedValue(makeTrailer({ deletedAt: new Date() }) as never);
      await expect(service.remove('tr_1')).rejects.toMatchObject({ status: 404 });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  it('exportAll maps to the CreateTrailerDto shape', async () => {
    repo.listAll.mockResolvedValue([makeTrailer({ vin: null })] as never);
    const rows = await service.exportAll();
    expect(rows).toEqual([{ number: 'TR-1', vin: undefined }]);
  });

  it('importMany creates new and updates existing rows, tolerating per-row failures', async () => {
    repo.findByNumber
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeTrailer() as never)
      .mockResolvedValueOnce(null);
    repo.create.mockResolvedValueOnce(makeTrailer() as never).mockRejectedValueOnce(new Error('boom'));
    repo.update.mockResolvedValue(makeTrailer() as never);

    const summary = await service.importMany({
      trailers: [
        { number: 'A', vin: 'V-A' },
        { number: 'B', vin: 'V-B' },
        { number: 'C', vin: 'V-C' },
      ],
    });

    expect(summary.imported).toBe(1);
    expect(summary.updated).toBe(1);
    expect(summary.failed).toEqual([{ index: 2, error: 'boom' }]);
  });
});
