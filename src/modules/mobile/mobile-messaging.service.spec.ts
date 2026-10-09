import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import type { MessagingRepository } from '../messaging/messaging.repository';
import type { MessagingService } from '../messaging/messaging.service';
import { MobileMessagingRepository } from './mobile-messaging.repository';
import { MobileRepository } from './mobile.repository';
import { MobileMessagingService } from './mobile-messaging.service';

const actor: ContextUser = { id: 'drv_1', type: 'driver' };

function build() {
  const repo = {
    listForDriver: jest.fn().mockResolvedValue([]),
    listMessagesCursor: jest.fn().mockResolvedValue([]),
    markRead: jest.fn().mockResolvedValue({ messagesMarked: 0 }),
    nameMaps: jest.fn().mockResolvedValue({ users: new Map([['usr_1', 'Jane Dispatcher']]), drivers: new Map([['drv_1', 'John Smith']]) }),
    findMessageByClientId: jest.fn().mockResolvedValue(null),
    findActiveStaff: jest.fn().mockResolvedValue({ id: 'usr_1' }),
    findDirectConversation: jest.fn().mockResolvedValue(null),
    findSupportConversation: jest.fn().mockResolvedValue(null),
  };
  const mobileRepo = {
    findSyncedByClientId: jest.fn().mockResolvedValue(null),
    recordSyncedResult: jest.fn().mockResolvedValue({ status: 'ACCEPTED', errorCode: null }),
    findActivePairing: jest.fn().mockResolvedValue(null),
  };
  const msg = { id: 'msg_1', conversationId: 'cnv_1', body: 'hi', senderDriverId: 'drv_1', senderUserId: null, sentAt: new Date(), readAt: null, clientId: 'c1' };
  const messagingRepo = {
    findById: jest.fn().mockResolvedValue({ id: 'cnv_1' }),
    isParticipant: jest.fn().mockResolvedValue(true),
    createConversation: jest.fn().mockResolvedValue({ id: 'cnv_new' }),
  };
  const messaging = { sendMessage: jest.fn().mockResolvedValue(msg), notifyConversationStarted: jest.fn().mockResolvedValue(undefined) };
  const service = new MobileMessagingService(
    repo as unknown as MobileMessagingRepository,
    messagingRepo as unknown as MessagingRepository,
    messaging as unknown as MessagingService,
    mobileRepo as unknown as MobileRepository,
  );
  return { repo, messagingRepo, messaging, mobileRepo, service };
}

describe('MobileMessagingService', () => {
  it('lists conversations for the driver', async () => {
    const { repo, service } = build();
    repo.listForDriver.mockResolvedValue([{ id: 'cnv_1', type: 'DIRECT', title: null, unreadCount: 2, lastMessage: null, rawParticipants: [] }]);
    const result = await service.listConversations('drv_1');
    expect(result.items[0]).toMatchObject({ id: 'cnv_1', unreadCount: 2, participants: [], title: null });
  });

  it('404s listMessages when the conversation does not exist', async () => {
    const { messagingRepo, service } = build();
    messagingRepo.findById.mockResolvedValue(null);
    await expect(service.listMessages('cnv_x', 'drv_1', { limit: 50 })).rejects.toBeInstanceOf(AppException);
  });

  it('403s listMessages when the driver is not a participant', async () => {
    const { messagingRepo, service } = build();
    messagingRepo.isParticipant.mockResolvedValue(false);
    try {
      await service.listMessages('cnv_1', 'drv_1', { limit: 50 });
      fail('expected forbidden');
    } catch (err) {
      expect((err as AppException).code).toBe(ERROR_CODES.FORBIDDEN);
    }
  });

  it('delegates sendMessage to the existing MessagingService (so message.new still fires)', async () => {
    const { messaging, service } = build();
    await service.sendMessage('cnv_1', { body: 'hi' }, actor);
    expect(messaging.sendMessage).toHaveBeenCalledWith('cnv_1', { body: 'hi' }, actor);
  });

  it('marks the conversation read only for a participant', async () => {
    const { repo, service } = build();
    await service.markRead('cnv_1', 'drv_1');
    expect(repo.markRead).toHaveBeenCalledWith('cnv_1', 'drv_1', expect.any(Date));
  });

  it('sendMessage returns the MR-18 shape (senderId/senderType/senderName/clientId)', async () => {
    const { service } = build();
    const out = await service.sendMessage('cnv_1', { body: 'hi', clientId: 'c1' }, actor);
    expect(out).toMatchObject({ senderId: 'drv_1', senderType: 'DRIVER', senderName: 'John Smith', clientId: 'c1', readAt: null });
  });

  it('sendMessage replay of a delivered clientId does not create a second message', async () => {
    const { repo, messaging, service } = build();
    repo.findMessageByClientId.mockResolvedValue({ id: 'msg_1', conversationId: 'cnv_1', senderDriverId: 'drv_1', senderUserId: null, body: 'hi', clientId: 'c1' });
    await service.sendMessage('cnv_1', { body: 'hi', clientId: 'c1' }, actor);
    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('startConversation creates a DIRECT thread with a staff contact and records the ledger', async () => {
    const { messagingRepo, mobileRepo, messaging, service } = build();
    const out = await service.startConversation('drv_1', { contactId: '0b9d6f5e-0000-4000-8000-000000000001', body: 'hi', clientId: 'c1' }, actor);
    expect(messagingRepo.createConversation).toHaveBeenCalledWith({ type: 'DIRECT', createdById: 'drv_1' }, [{ driverId: 'drv_1' }, { userId: 'usr_1' }]);
    expect(out).toMatchObject({ conversationId: 'cnv_new', message: { id: 'msg_1', senderType: 'DRIVER', clientId: 'c1' } });
    expect(mobileRepo.recordSyncedResult).toHaveBeenCalled();
    expect(messaging.notifyConversationStarted).toHaveBeenCalledWith('usr_1', 'cnv_new', expect.anything());
  });

  it('startConversation reuses an existing DIRECT conversation', async () => {
    const { repo, messagingRepo, service } = build();
    repo.findDirectConversation.mockResolvedValue({ id: 'cnv_old' });
    const out = await service.startConversation('drv_1', { contactId: '0b9d6f5e-0000-4000-8000-000000000001', body: 'hi', clientId: 'c1' }, actor);
    expect(messagingRepo.createConversation).not.toHaveBeenCalled();
    expect(out.conversationId).toBe('cnv_old');
  });

  it('startConversation with "support" opens a SUPPORT conversation', async () => {
    const { messagingRepo, service } = build();
    await service.startConversation('drv_1', { contactId: 'support', body: 'help', clientId: 'c2' }, actor);
    expect(messagingRepo.createConversation).toHaveBeenCalledWith(expect.objectContaining({ type: 'SUPPORT' }), [{ driverId: 'drv_1' }]);
  });

  it('startConversation replays the ledger result for a repeated clientId', async () => {
    const { mobileRepo, messaging, service } = build();
    mobileRepo.findSyncedByClientId.mockResolvedValue({ type: 'create_conversation', status: 'ACCEPTED', result: { conversationId: 'cnv_1' } });
    const out = await service.startConversation('drv_1', { contactId: 'support', body: 'help', clientId: 'c2' }, actor);
    expect(out).toEqual({ conversationId: 'cnv_1' });
    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('startConversation refuses a clientId recorded for another ledger operation (409, no stored result leaked)', async () => {
    const { mobileRepo, messaging, service } = build();
    mobileRepo.findSyncedByClientId.mockResolvedValue({ type: 'release_vehicle', status: 'ACCEPTED', result: { released: true, vehicleId: 'veh_1' } });
    await expect(service.startConversation('drv_1', { contactId: 'support', body: 'help', clientId: 'c2' }, actor)).rejects.toMatchObject({ status: 409 });
    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('startConversation 404s for an unknown contact', async () => {
    const { repo, service } = build();
    repo.findActiveStaff.mockResolvedValue(null);
    await expect(service.startConversation('drv_1', { contactId: '0b9d6f5e-0000-4000-8000-000000000009', body: 'x', clientId: 'c3' }, actor)).rejects.toBeInstanceOf(AppException);
  });
});
