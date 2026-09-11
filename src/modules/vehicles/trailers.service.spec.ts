import { AppException } from '../../common/errors/app.exception';
import { TrailersRepository } from './trailers.repository';
import { TrailersService } from './trailers.service';

function makeTrailer(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'tr_1', number: 'TR-1', vin: 'VIN1', status: 'ACTIVE', ...overrides };
}

describe('TrailersService', () => {
  let repo: jest.Mocked<Pick<TrailersRepository, 'listAll' | 'findById' | 'findByNumber' | 'create' | 'update' | 'delete'>>;
  let service: TrailersService;

  beforeEach(() => {
    repo = {
      listAll: jest.fn(),
      findById: jest.fn(),
      findByNumber: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    service = new TrailersService(repo as unknown as TrailersRepository);
  });

  it('list delegates to listAll', async () => {
    repo.listAll.mockResolvedValue([makeTrailer()] as never);
    const result = await service.list();
    expect(result).toHaveLength(1);
  });

  it('get throws notFound when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toThrow(AppException);
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

    it('deletes when found', async () => {
      repo.findById.mockResolvedValue(makeTrailer() as never);
      repo.delete.mockResolvedValue(makeTrailer() as never);
      await service.remove('tr_1');
      expect(repo.delete).toHaveBeenCalledWith({ id: 'tr_1' });
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
