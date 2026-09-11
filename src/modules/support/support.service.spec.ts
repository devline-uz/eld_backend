import { SupportRepository } from './support.repository';
import { SupportService } from './support.service';

function makeTicket(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tck_1',
    number: 'TCK-000001',
    subject: 'Device offline',
    body: 'Unit #101 device has not reported in 2 days.',
    priority: 'NORMAL',
    status: 'OPEN',
    ...overrides,
  };
}

describe('SupportService', () => {
  let repo: jest.Mocked<
    Pick<SupportRepository, 'list' | 'findById' | 'create' | 'update' | 'count' | 'createFeedback'>
  >;
  let service: SupportService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      createFeedback: jest.fn(),
    };
    service = new SupportService(repo as unknown as SupportRepository);
  });

  it('list parses sort and returns an offset page', async () => {
    repo.list.mockResolvedValue({ items: [makeTicket()], total: 1 } as never);
    const result = await service.list({ page: 1, limit: 25 });
    expect(repo.list).toHaveBeenCalledWith({ status: undefined, priority: undefined, q: undefined }, 1, 25, {
      createdAt: 'desc',
    });
    expect(result.total).toBe(1);
  });

  describe('get', () => {
    it('throws notFound when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.get('missing')).rejects.toThrow();
    });

    it('returns the ticket when found', async () => {
      repo.findById.mockResolvedValue(makeTicket() as never);
      const result = await service.get('tck_1');
      expect(result.id).toBe('tck_1');
    });
  });

  describe('create', () => {
    it('allocates a zero-padded ticket number from the current row count', async () => {
      repo.count.mockResolvedValue(4);
      repo.create.mockResolvedValue(makeTicket({ number: 'TCK-000005' }) as never);

      await service.create(
        { subject: 'Device offline', body: 'body', priority: 'NORMAL' },
        { id: 'usr_1', type: 'user' },
      );

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ number: 'TCK-000005', createdByUserId: 'usr_1' }));
    });

    it('attributes the ticket to a driver requester instead of a user', async () => {
      repo.count.mockResolvedValue(0);
      repo.create.mockResolvedValue(makeTicket() as never);

      await service.create({ subject: 'Help', body: 'body', priority: 'NORMAL' }, { id: 'drv_1', type: 'driver' });

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ createdByDriverId: 'drv_1' }));
    });

    it('retries with the next number on a unique-constraint collision', async () => {
      repo.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      const conflict = Object.assign(new Error('unique violation'), { code: 'P2002' });
      repo.create.mockRejectedValueOnce(conflict).mockResolvedValueOnce(makeTicket({ number: 'TCK-000002' }) as never);

      const result = await service.create({ subject: 'Help', body: 'body', priority: 'NORMAL' }, { id: 'usr_1', type: 'user' });

      expect(repo.create).toHaveBeenCalledTimes(2);
      expect(result.number).toBe('TCK-000002');
    });
  });

  describe('update', () => {
    it('throws notFound when the ticket is missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.update('missing', {})).rejects.toThrow();
    });

    it('stamps resolvedAt when moving into RESOLVED', async () => {
      repo.findById.mockResolvedValue(makeTicket() as never);
      repo.update.mockResolvedValue(makeTicket({ status: 'RESOLVED' }) as never);

      await service.update('tck_1', { status: 'RESOLVED' });

      expect(repo.update).toHaveBeenCalledTimes(1);
      const [where, data] = repo.update.mock.calls[0];
      expect(where).toEqual({ id: 'tck_1' });
      expect(data).toMatchObject({ status: 'RESOLVED' });
      expect((data as { resolvedAt?: Date }).resolvedAt).toBeInstanceOf(Date);
    });

    it('stamps resolvedAt when moving into CLOSED too', async () => {
      repo.findById.mockResolvedValue(makeTicket() as never);
      repo.update.mockResolvedValue(makeTicket({ status: 'CLOSED' }) as never);
      await service.update('tck_1', { status: 'CLOSED' });
      const [, data] = repo.update.mock.calls[0];
      expect((data as { resolvedAt?: Date }).resolvedAt).toBeInstanceOf(Date);
    });

    it('applies priority/assignedToId without touching resolvedAt for a non-terminal status', async () => {
      repo.findById.mockResolvedValue(makeTicket() as never);
      repo.update.mockResolvedValue(makeTicket() as never);
      await service.update('tck_1', { priority: 'HIGH', assignedToId: 'usr_2' } as never);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'tck_1' },
        { priority: 'HIGH', assignedToId: 'usr_2' },
      );
    });
  });

  describe('createFeedback', () => {
    it('attributes feedback to a driver requester', async () => {
      repo.createFeedback.mockResolvedValue({ id: 'fb_1' } as never);

      await service.createFeedback({ answers: { rating: 5 } }, { id: 'drv_1', type: 'driver' });

      expect(repo.createFeedback).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'drv_1' }));
    });

    it('attributes feedback to a user requester', async () => {
      repo.createFeedback.mockResolvedValue({ id: 'fb_1' } as never);

      await service.createFeedback({ answers: { rating: 5 } }, { id: 'usr_1', type: 'user' });

      expect(repo.createFeedback).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_1' }));
    });
  });
});
