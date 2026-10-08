import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage } from '../../common/dto/list-query.dto';
import { EventBusService } from '../../core/events/event-bus.service';
import type { ContextUser } from '../../core/context/request-context';
import { BroadcastMessageDto, CreateConversationDto, SendMessageDto } from './dto/messaging.dto';
import { MessagingRepository, Participant } from './messaging.repository';

function toParticipant(actor: ContextUser): Participant {
  return actor.type === 'driver' ? { driverId: actor.id } : { userId: actor.id };
}

@Injectable()
export class MessagingService {
  constructor(private readonly repo: MessagingRepository, private readonly events: EventBusService) {}

  async listConversations(actor: ContextUser) {
    const items = await this.repo.listForActor(toParticipant(actor));
    return { items };
  }

  async createConversation(dto: CreateConversationDto, actor: ContextUser) {
    const participants: Participant[] = [
      toParticipant(actor),
      ...dto.driverIds.map((id) => ({ driverId: id })),
      ...dto.userIds.map((id) => ({ userId: id })),
    ];
    return this.repo.createConversation({ type: dto.type, title: dto.title, createdById: actor.id }, participants);
  }

  /** §20 B-67 — `POST /conversations/:id/read`. */
  async markRead(conversationId: string, actor: ContextUser) {
    await this.assertParticipant(conversationId, actor);
    const readAt = new Date();
    await this.repo.markRead(conversationId, toParticipant(actor), readAt);
    return { conversationId, lastReadAt: readAt };
  }

  private async assertParticipant(conversationId: string, actor: ContextUser): Promise<void> {
    const conversation = await this.repo.findById(conversationId);
    if (!conversation) throw new AppException(ERROR_CODES.NOT_FOUND, 'Conversation not found.', 404);
    const ok = await this.repo.isParticipant(conversationId, toParticipant(actor));
    if (!ok) throw new AppException(ERROR_CODES.FORBIDDEN, 'Not a participant of this conversation.', 403);
  }

  async listMessages(conversationId: string, actor: ContextUser, page: number, limit: number): Promise<OffsetPage<unknown>> {
    await this.assertParticipant(conversationId, actor);
    const { items, total } = await this.repo.listMessages(conversationId, page, limit);
    return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async sendMessage(conversationId: string, dto: SendMessageDto, actor: ContextUser) {
    await this.assertParticipant(conversationId, actor);
    const participant = toParticipant(actor);
    const message = await this.repo.createMessage(conversationId, {
      body: dto.body,
      attachmentId: dto.attachmentId,
      clientId: dto.clientId,
      senderUserId: participant.userId,
      senderDriverId: participant.driverId,
    });
    await this.events.publish('realtime.push', {
      room: `conversation:${conversationId}`,
      event: 'message.new',
      payload: { message },
    });
    return message;
  }

  /** MR-3 — tells a staff member's open sessions a driver started a thread with them. */
  async notifyConversationStarted(userId: string, conversationId: string, message: unknown): Promise<void> {
    await this.events.publish('realtime.push', {
      room: `user:${userId}`,
      event: 'conversation.new',
      payload: { conversationId, message },
    });
  }

  /** TZ §11.5 `POST /messages/broadcast` — one message, many one-to-one deliveries. */
  async broadcast(dto: BroadcastMessageDto, actor: ContextUser) {
    const results = [];
    for (const driverId of dto.driverIds) {
      const conversation = await this.repo.createConversation(
        { type: 'BROADCAST', title: dto.title, createdById: actor.id },
        [toParticipant(actor), { driverId }],
      );
      const message = await this.sendMessage(conversation.id, { body: dto.body }, actor);
      results.push({ conversationId: conversation.id, messageId: message.id, driverId });
    }
    return { sent: results.length, deliveries: results };
  }
}
