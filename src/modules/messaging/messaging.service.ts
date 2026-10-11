import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage } from '../../common/dto/list-query.dto';
import { PushService } from '../../core/firebase/push.service';
import { EventBusService } from '../../core/events/event-bus.service';
import type { ContextUser } from '../../core/context/request-context';
import { BroadcastMessageDto, CreateConversationDto, SendMessageDto } from './dto/messaging.dto';
import { MessagingRepository, Participant } from './messaging.repository';

function toParticipant(actor: ContextUser): Participant {
  return actor.type === 'driver' ? { driverId: actor.id } : { userId: actor.id };
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly repo: MessagingRepository,
    private readonly events: EventBusService,
    private readonly push: PushService,
  ) {}

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
    const conversation = await this.repo.createConversation({ type: dto.type, title: dto.title, createdById: actor.id }, participants);
    if (actor.type !== 'driver') await this.notifyDriversConversationOpened(conversation, actor);
    return conversation;
  }

  /**
   * MB-8 — a staff member opened a thread with a driver: `conversation.new` to each driver's
   * `driver:{id}` room so an open app adds it without polling. Best-effort, never throws.
   */
  private async notifyDriversConversationOpened(
    conversation: { id: string; type: string; title: string | null; participants?: Array<{ driverId: string | null }> },
    actor: ContextUser,
  ): Promise<void> {
    try {
      for (const p of conversation.participants ?? []) {
        if (!p.driverId || p.driverId === actor.id) continue;
        await this.events.publish('realtime.push', {
          room: `driver:${p.driverId}`,
          event: 'conversation.new',
          payload: { conversationId: conversation.id, type: conversation.type, title: conversation.title },
        });
      }
    } catch (err) {
      this.logger.warn({ conversationId: conversation.id, err: err instanceof Error ? err.message : String(err) }, 'conversation.new emit failed');
    }
  }

  /** §20 B-67 — `POST /conversations/:id/read`. */
  async markRead(conversationId: string, actor: ContextUser) {
    await this.assertParticipant(conversationId, actor);
    const readAt = new Date();
    await this.repo.markRead(conversationId, toParticipant(actor), readAt);
    return { conversationId, lastReadAt: readAt };
  }

  private async assertParticipant(conversationId: string, actor: ContextUser) {
    const conversation = await this.repo.findById(conversationId);
    if (!conversation) throw new AppException(ERROR_CODES.NOT_FOUND, 'Conversation not found.', 404);
    const ok = await this.repo.isParticipant(conversationId, toParticipant(actor));
    if (!ok) throw new AppException(ERROR_CODES.FORBIDDEN, 'Not a participant of this conversation.', 403);
    return conversation;
  }

  async listMessages(conversationId: string, actor: ContextUser, page: number, limit: number): Promise<OffsetPage<unknown>> {
    await this.assertParticipant(conversationId, actor);
    const { items, total } = await this.repo.listMessages(conversationId, page, limit);
    return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async sendMessage(conversationId: string, dto: SendMessageDto, actor: ContextUser) {
    const conversation = await this.assertParticipant(conversationId, actor);
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
    if (actor.type !== 'driver') await this.pushToDrivers(conversation, message, participant);
    return message;
  }

  /**
   * Best-effort FCM for a staff-sent message: every token of each driver participant (never
   * the sender). Identifiers only in `data`; failures are logged, never thrown.
   */
  private async pushToDrivers(
    conversation: { participants?: Array<{ driverId: string | null }> },
    message: { id: string; conversationId: string; body: string; attachmentId: string | null },
    sender: Participant,
  ): Promise<void> {
    try {
      const driverIds = (conversation.participants ?? [])
        .map((p) => p.driverId)
        .filter((id): id is string => !!id && id !== sender.driverId);
      if (!driverIds.length) return;
      const title = (sender.userId && (await this.repo.findUserDisplayName(sender.userId))) || 'Dispatch';
      const text = message.body?.trim();
      const body = text ? (text.length > 100 ? `${text.slice(0, 97)}...` : text) : message.attachmentId ? 'Sent an attachment' : '';
      for (const driverId of driverIds) {
        await this.push.sendToDriver(
          driverId,
          { title, body },
          { type: 'message.new', conversationId: message.conversationId, messageId: message.id, driverId },
        );
      }
    } catch (err) {
      this.logger.warn({ conversationId: message.conversationId, err: err instanceof Error ? err.message : String(err) }, 'Chat FCM failed');
    }
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
      await this.notifyDriversConversationOpened(conversation, actor);
      const message = await this.sendMessage(conversation.id, { body: dto.body }, actor);
      results.push({ conversationId: conversation.id, messageId: message.id, driverId });
    }
    return { sent: results.length, deliveries: results };
  }
}
