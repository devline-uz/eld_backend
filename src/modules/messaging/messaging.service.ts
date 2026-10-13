import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage } from '../../common/dto/list-query.dto';
import { PushService } from '../../core/firebase/push.service';
import { EventBusService } from '../../core/events/event-bus.service';
import type { ContextUser } from '../../core/context/request-context';
import { BroadcastMessageDto, CreateConversationDto, SendMessageDto } from './dto/messaging.dto';
import { ChatAttachmentsService } from '../attachments/chat-attachments.service';
import { MessagingRepository, Participant } from './messaging.repository';

function toParticipant(actor: ContextUser): Participant {
  return actor.type === 'driver' ? { driverId: actor.id } : { userId: actor.id };
}

/** A staff participant's identity room (`user:{id}`) — auto-joined by `RealtimeGateway` on
 * connect, so a push there needs no `subscribe` and reaches a brand-new conversation's staff
 * members too. Drivers get no identity-room pushes from here. */
export function staffRoom(p: Participant): string | null {
  return p.userId ? `user:${p.userId}` : null;
}

function staffRooms(participants: Participant[]): string[] {
  return [...new Set(participants.map(staffRoom).filter((r): r is string => r !== null))];
}

/**
 * Realtime chat contract for the web panel (namespace `/realtime`):
 *  - `message.new` `{ conversationId, message }` → `conversation:{id}` + every STAFF participant's
 *    identity room (`user:{id}`), the sender included (multi-tab sync), in ONE multi-room push, so
 *    each socket gets it once. Clients still dedupe on `message.id`.
 *  - `conversation.new` `{ conversationId, conversation?, message }` → the staff identity rooms of
 *    a staff-created or broadcast conversation.
 *  - `conversation.read` `{ conversationId, lastReadAt, userId }` → the reading staff user's own
 *    identity room only (unread badges in sync across that user's tabs).
 *  - `message.read` `{ conversationId, readerType: 'DRIVER'|'STAFF', readerId, lastReadMessageId,
 *    readAt }` → `conversation:{id}` + every driver participant's `driver:{id}` + every staff
 *    participant's `user:{id}`; fired on both the driver and the staff read.
 *  - `typing` (client emits `typing {conversationId,isTyping}`; relayed by `RealtimeGateway`).
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly repo: MessagingRepository,
    private readonly events: EventBusService,
    private readonly push: PushService,
    private readonly chatAttachments: ChatAttachmentsService,
  ) {}

  async listConversations(actor: ContextUser) {
    const items = await this.repo.listForActor(toParticipant(actor));
    return { items };
  }

  /**
   * Web `POST /conversations`. BE-012 — recipients are de-duplicated (the creator is never added
   * twice); a DIRECT conversation has exactly one other participant and re-opening one that
   * already exists returns it instead of creating a duplicate; GROUP/BROADCAST need at least one.
   * BE-010 — unknown / deleted drivers and unknown users are a 422 (`details.driverIds` /
   * `details.userIds` list them), not an FK 500. The mobile chat never reaches this method.
   */
  async createConversation(dto: CreateConversationDto, actor: ContextUser) {
    const self = toParticipant(actor);
    const driverIds = [...new Set(dto.driverIds)].filter((id) => id !== self.driverId);
    const userIds = [...new Set(dto.userIds)].filter((id) => id !== self.userId);
    const others = driverIds.length + userIds.length;
    if (dto.type === 'DIRECT' && others !== 1) {
      const message = 'A direct conversation needs exactly one other participant.';
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, { driverIds: message });
    }
    if (others === 0) {
      const message = 'Add at least one participant.';
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, { driverIds: message });
    }
    await this.assertRecipientsExist(driverIds, userIds);
    const recipients: Participant[] = [...driverIds.map((id) => ({ driverId: id })), ...userIds.map((id) => ({ userId: id }))];
    if (dto.type === 'DIRECT') {
      const existing = await this.repo.findDirectBetween(self, recipients[0]);
      if (existing) return existing;
    }
    const participants: Participant[] = [self, ...recipients];
    const conversation = await this.repo.createConversation({ type: dto.type, title: dto.title, createdById: actor.id }, participants);
    await this.notifyConversationCreated(conversation.id, participants, null, conversation);
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

  /** §20 B-67 — `POST /conversations/:id/read`. Stamps `readAt` on the other side's messages too. */
  async markRead(conversationId: string, actor: ContextUser) {
    const conversation = await this.assertParticipant(conversationId, actor);
    const readAt = new Date();
    const reader = toParticipant(actor);
    const { lastReadMessageId } = (await this.repo.markRead(conversationId, reader, readAt)) ?? { lastReadMessageId: null };
    await this.notifyRead(conversationId, reader, readAt);
    await this.publishMessageRead(
      conversationId,
      {
        readerType: actor.type === 'driver' ? 'DRIVER' : 'STAFF',
        readerId: actor.id,
        lastReadMessageId: lastReadMessageId ?? null,
        readAt,
      },
      conversation.participants,
    );
    return { conversationId, lastReadAt: readAt };
  }

  /** `message.read` to the conversation room, each driver's `driver:{id}` and each staff
   * `user:{id}` room in ONE multi-room push. Best effort: never fails the REST call. */
  async publishMessageRead(
    conversationId: string,
    read: { readerType: 'DRIVER' | 'STAFF'; readerId: string; lastReadMessageId: string | null; readAt: Date },
    participants: Array<{ userId: string | null; driverId: string | null }> = [],
  ): Promise<void> {
    const rooms = new Set<string>([`conversation:${conversationId}`]);
    for (const p of participants) {
      if (p.driverId) rooms.add(`driver:${p.driverId}`);
      if (p.userId) rooms.add(`user:${p.userId}`);
    }
    await this.events
      .publish('realtime.push', { room: [...rooms], event: 'message.read', payload: { conversationId, ...read } })
      .catch((err) => this.logger.warn({ conversationId, err: err instanceof Error ? err.message : String(err) }, 'message.read emit failed'));
  }

  /** `conversation.read` to the reading staff user's own identity room. Best effort: a push
   * failure never fails the REST call. */
  private async notifyRead(conversationId: string, reader: Participant, lastReadAt: Date): Promise<void> {
    const room = staffRoom(reader);
    if (!room) return;
    await this.events
      .publish('realtime.push', {
        room,
        event: 'conversation.read',
        payload: { conversationId, lastReadAt, userId: reader.userId },
      })
      .catch(() => undefined);
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
    // deliveredAt: the reader fetching the thread is the delivery of the other side's messages.
    await this.repo.markDelivered(conversationId, toParticipant(actor)).catch(() => 0);
    const { items, total } = await this.repo.listMessages(conversationId, page, limit);
    return { items: await this.chatAttachments.decorate(items), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async sendMessage(conversationId: string, dto: SendMessageDto, actor: ContextUser) {
    const conversation = await this.assertParticipant(conversationId, actor);
    const participant = toParticipant(actor);
    if (dto.attachmentId) await this.chatAttachments.assertSendable(dto.attachmentId, actor);
    const created = await this.repo.createMessage(conversationId, {
      body: dto.body,
      attachmentId: dto.attachmentId,
      clientId: dto.clientId,
      senderUserId: participant.userId,
      senderDriverId: participant.driverId,
    });
    const [message] = await this.chatAttachments.decorate([created]);
    // The conversation room (legacy subscribers) plus every staff participant's auto-joined
    // identity room — the web panel gets it without subscribing, even for a thread it has never
    // listed. One multi-room push: a socket in several of these rooms gets it once.
    const participants: Participant[] = (conversation.participants ?? []).map((p) => ({
      userId: p.userId ?? undefined,
      driverId: p.driverId ?? undefined,
    }));
    await this.events.publish('realtime.push', {
      room: [`conversation:${conversationId}`, ...staffRooms(participants)],
      event: 'message.new',
      // `senderId`/`senderType` are additive; the raw row's `senderUserId`/`senderDriverId` stay.
      payload: {
        conversationId,
        message: {
          ...message,
          senderId: message.senderDriverId ?? message.senderUserId ?? null,
          senderType: message.senderDriverId ? 'DRIVER' : message.senderUserId ? 'STAFF' : 'SYSTEM',
        },
      },
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
          {
            type: 'message.new',
            conversationId: message.conversationId,
            messageId: message.id,
            driverId,
            objectType: 'Conversation',
            objectId: message.conversationId,
            category: 'message',
          },
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

  /** `conversation.new` to every staff participant's identity room (creator included, for their
   * other tabs) so a new thread shows up in the web list without polling. Best effort. */
  private async notifyConversationCreated(
    conversationId: string,
    participants: Participant[],
    message: unknown,
    conversation?: unknown,
  ): Promise<void> {
    const rooms = staffRooms(participants);
    if (!rooms.length) return;
    await this.events
      .publish('realtime.push', {
        room: rooms,
        event: 'conversation.new',
        payload: { conversationId, ...(conversation !== undefined && { conversation }), message },
      })
      .catch(() => undefined);
  }

  /** BE-010 — 422 naming every unknown / soft-deleted driver and unknown user. */
  private async assertRecipientsExist(driverIds: string[], userIds: string[]): Promise<void> {
    const [liveDrivers, users] = await Promise.all([this.repo.findLiveDriverIds(driverIds), this.repo.findUserIds(userIds)]);
    const missingDrivers = driverIds.filter((id) => !liveDrivers.has(id));
    const missingUsers = userIds.filter((id) => !users.has(id));
    if (missingDrivers.length === 0 && missingUsers.length === 0) return;
    throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Some recipients were not found.', 422, {
      ...(missingDrivers.length > 0 && { driverIds: missingDrivers }),
      ...(missingUsers.length > 0 && { userIds: missingUsers }),
    });
  }

  /** TZ §11.5 `POST /messages/broadcast` — one message, many one-to-one deliveries. Recipients are
   * de-duplicated and validated up front (BE-010), so nothing is sent if any id is bad. */
  async broadcast(dto: BroadcastMessageDto, actor: ContextUser) {
    const driverIds = [...new Set(dto.driverIds)];
    await this.assertRecipientsExist(driverIds, []);
    const results = [];
    for (const driverId of driverIds) {
      const participants = [toParticipant(actor), { driverId }];
      const conversation = await this.repo.createConversation(
        { type: 'BROADCAST', title: dto.title, createdById: actor.id },
        participants,
      );
      await this.notifyDriversConversationOpened(conversation, actor);
      const message = await this.sendMessage(conversation.id, { body: dto.body }, actor);
      await this.notifyConversationCreated(conversation.id, participants, message, conversation);
      results.push({ conversationId: conversation.id, messageId: message.id, driverId });
    }
    return { sent: results.length, deliveries: results };
  }
}
