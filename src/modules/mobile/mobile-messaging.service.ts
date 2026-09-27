import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { MessagingRepository } from '../messaging/messaging.repository';
import { MessagingService } from '../messaging/messaging.service';
import type { ListMessagesQueryDto, MobileSendMessageDto } from './dto/mobile-messaging.dto';
import { MobileMessagingRepository } from './mobile-messaging.repository';

/**
 * TZ §11.5 / mobile.tz §7.5 (screen S-14) — MB-15. Thin driver-facing layer over the existing
 * `MessagingService`/`MessagingRepository` (never `messaging.controller.ts`, which stays
 * untouched): conversation list gets a last-message + unread-count summary the web contract
 * does not need, message listing is cursor-based instead of offset-paged, and sending/reading
 * reuse the shared service/repository outright so the `message.new` realtime push and the
 * participant check are never duplicated.
 */
@Injectable()
export class MobileMessagingService {
  constructor(
    private readonly repo: MobileMessagingRepository,
    private readonly messagingRepo: MessagingRepository,
    private readonly messaging: MessagingService,
  ) {}

  listConversations(driverId: string) {
    return this.repo.listForDriver(driverId).then((items) => ({ items }));
  }

  async listMessages(conversationId: string, driverId: string, query: ListMessagesQueryDto) {
    await this.assertParticipant(conversationId, driverId);
    const items = await this.repo.listMessagesCursor(conversationId, query.limit, query.before);
    return { items, limit: query.limit };
  }

  async sendMessage(conversationId: string, dto: MobileSendMessageDto, actor: ContextUser) {
    // `MessagingService.sendMessage` re-checks participation itself (403), creates the
    // message and publishes `realtime.push` / `message.new` — reused verbatim.
    return this.messaging.sendMessage(conversationId, dto, actor);
  }

  async markRead(conversationId: string, driverId: string, now: Date = new Date()) {
    await this.assertParticipant(conversationId, driverId);
    return this.repo.markRead(conversationId, driverId, now);
  }

  private async assertParticipant(conversationId: string, driverId: string): Promise<void> {
    const conversation = await this.messagingRepo.findById(conversationId);
    if (!conversation) throw new AppException(ERROR_CODES.NOT_FOUND, 'Conversation not found.', 404);
    const ok = await this.messagingRepo.isParticipant(conversationId, { driverId });
    if (!ok) throw new AppException(ERROR_CODES.FORBIDDEN, 'Not a participant of this conversation.', 403);
  }
}
