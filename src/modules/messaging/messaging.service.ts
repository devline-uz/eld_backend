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
 */
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
    const conversation = await this.repo.createConversation({ type: dto.type, title: dto.title, createdById: actor.id }, participants);
    await this.notifyConversationCreated(conversation.id, participants, null, conversation);
    return conversation;
  }

  /** §20 B-67 — `POST /conversations/:id/read`. */
  async markRead(conversationId: string, actor: ContextUser) {
    await this.assertParticipant(conversationId, actor);
    const readAt = new Date();
    const reader = toParticipant(actor);
    await this.repo.markRead(conversationId, reader, readAt);
    await this.notifyRead(conversationId, reader, readAt);
    return { conversationId, lastReadAt: readAt };
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

  /** TZ §11.5 `POST /messages/broadcast` — one message, many one-to-one deliveries. */
  async broadcast(dto: BroadcastMessageDto, actor: ContextUser) {
    const results = [];
    for (const driverId of dto.driverIds) {
      const participants = [toParticipant(actor), { driverId }];
      const conversation = await this.repo.createConversation(
        { type: 'BROADCAST', title: dto.title, createdById: actor.id },
        participants,
      );
      const message = await this.sendMessage(conversation.id, { body: dto.body }, actor);
      await this.notifyConversationCreated(conversation.id, participants, message, conversation);
      results.push({ conversationId: conversation.id, messageId: message.id, driverId });
    }
    return { sent: results.length, deliveries: results };
  }
}
