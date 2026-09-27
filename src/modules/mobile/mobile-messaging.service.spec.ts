import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import type { MessagingRepository } from '../messaging/messaging.repository';
import type { MessagingService } from '../messaging/messaging.service';
import { MobileMessagingRepository } from './mobile-messaging.repository';
import { MobileMessagingService } from './mobile-messaging.service';

const actor: ContextUser = { id: 'drv_1', type: 'driver' };

function build() {
  const repo = {
    listForDriver: jest.fn().mockResolvedValue([]),
    listMessagesCursor: jest.fn().mockResolvedValue([]),
    markRead: jest.fn().mockResolvedValue({ messagesMarked: 0 }),
  };
  const messagingRepo = {
    findById: jest.fn().mockResolvedValue({ id: 'cnv_1' }),
    isParticipant: jest.fn().mockResolvedValue(true),
  };
  const messaging = { sendMessage: jest.fn().mockResolvedValue({ id: 'msg_1' }) };
  const service = new MobileMessagingService(
    repo as unknown as MobileMessagingRepository,
    messagingRepo as unknown as MessagingRepository,
    messaging as unknown as MessagingService,
  );
  return { repo, messagingRepo, messaging, service };
}

describe('MobileMessagingService', () => {
  it('lists conversations for the driver', async () => {
    const { repo, service } = build();
    repo.listForDriver.mockResolvedValue([{ id: 'cnv_1', unreadCount: 2 }]);
    const result = await service.listConversations('drv_1');
    expect(result).toEqual({ items: [{ id: 'cnv_1', unreadCount: 2 }] });
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
});
