import { MessagingRepository } from '../messaging/messaging.repository';
import { MessagingService } from '../messaging/messaging.service';
import { SupportRepository } from './support.repository';
import { SupportService } from './support.service';
import { TicketAttachmentsService } from './ticket-attachments.service';

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
    Pick<SupportRepository, 'list' | 'findById' | 'create' | 'update' | 'count' | 'createFeedback' | 'requesterNames'>
  >;
  let attachments: jest.Mocked<Pick<TicketAttachmentsService, 'collect'>>;
  let messagingRepo: jest.Mocked<Pick<MessagingRepository, 'createConversation'>>;
  let messaging: jest.Mocked<Pick<MessagingService, 'sendMessage'>>;
  let service: SupportService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      requesterNames: jest.fn().mockResolvedValue(new Map()),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      createFeedback: jest.fn(),
    };
    attachments = { collect: jest.fn().mockResolvedValue(undefined) };
    messagingRepo = { createConversation: jest.fn() };
    messaging = { sendMessage: jest.fn() };
    service = new SupportService(
      repo as unknown as SupportRepository,
      attachments as unknown as TicketAttachmentsService,
      messagingRepo as unknown as MessagingRepository,
      messaging as unknown as MessagingService,
    );
  });

  it('list parses sort and returns an offset page', async () => {
    repo.list.mockResolvedValue({ items: [makeTicket()], total: 1 } as never);
    const result = await service.list({ page: 1, limit: 25 });
    expect(repo.list).toHaveBeenCalledWith({ status: undefined, priority: undefined, q: undefined }, 1, 25, {
      createdAt: 'desc',
    });
    expect(result.total).toBe(1);
  });

  it('list adds requesterName for the OPENED BY column', async () => {
    repo.list.mockResolvedValue({ items: [makeTicket({ createdByUserId: 'usr_1' }), makeTicket({ id: 'tck_2', createdByUserId: null, createdByDriverId: 'drv_9' })], total: 2 } as never);
    repo.requesterNames.mockResolvedValue(new Map([['usr_1', 'Sarah Chen']]));
    const result = await service.list({ page: 1, limit: 25 });
    expect(repo.requesterNames).toHaveBeenCalledWith(['usr_1'], ['drv_9']);
    expect(result.items.map((t) => t.requesterName)).toEqual(['Sarah Chen', null]);
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

  describe('create — B-91 server-collected attachments', () => {
    it('collects the requested attachments after the ticket is created, scoped to vehicleId', async () => {
      repo.count.mockResolvedValue(0);
      repo.create.mockResolvedValue(makeTicket({ id: 'tck_9' }) as never);

      await service.create(
        {
          subject: 'Device offline',
          body: 'body',
          priority: 'NORMAL',
          vehicleId: 'veh_1',
          attachments: [{ kind: 'DEVICE_DIAGNOSTICS' }, { kind: 'ELD_EVENTS_24H' }],
        },
        { id: 'usr_1', type: 'user' },
      );

      expect(attachments.collect).toHaveBeenCalledWith('tck_9', 'veh_1', ['DEVICE_DIAGNOSTICS', 'ELD_EVENTS_24H']);
    });

    it('does not call the collector when no attachments were requested', async () => {
      repo.count.mockResolvedValue(0);
      repo.create.mockResolvedValue(makeTicket() as never);

      await service.create({ subject: 'Help', body: 'body', priority: 'NORMAL' }, { id: 'usr_1', type: 'user' });

      expect(attachments.collect).not.toHaveBeenCalled();
    });
  });

  describe('createChat (B-90)', () => {
    it('opens a SUPPORT conversation for the requester and sends the first message', async () => {
      messagingRepo.createConversation.mockResolvedValue({ id: 'cnv_9' } as never);
      messaging.sendMessage.mockResolvedValue({ id: 'msg_1' } as never);

      const result = await service.createChat({ subject: 'Need help', message: 'Hi there' }, { id: 'usr_1', type: 'user' });

      expect(messagingRepo.createConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SUPPORT', title: 'Need help', createdById: 'usr_1' }),
        [{ userId: 'usr_1' }],
      );
      expect(messaging.sendMessage).toHaveBeenCalledWith('cnv_9', { body: 'Hi there' }, { id: 'usr_1', type: 'user' });
      expect(result).toEqual({ conversationId: 'cnv_9', messageId: 'msg_1' });
    });

    it('scopes the conversation to a driver participant for a driver requester', async () => {
      messagingRepo.createConversation.mockResolvedValue({ id: 'cnv_10' } as never);
      messaging.sendMessage.mockResolvedValue({ id: 'msg_2' } as never);

      await service.createChat({ message: 'Hi' }, { id: 'drv_1', type: 'driver' });

      expect(messagingRepo.createConversation).toHaveBeenCalledWith(expect.anything(), [{ driverId: 'drv_1' }]);
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
