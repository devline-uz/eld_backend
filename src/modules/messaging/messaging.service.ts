import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Attachment, Message } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage } from '../../common/dto/list-query.dto';
import { EventBusService } from '../../core/events/event-bus.service';
import type { ContextUser } from '../../core/context/request-context';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import {
  BroadcastMessageDto,
  CreateConversationDto,
  SendAudioMessageDto,
  SendMessageDto,
} from './dto/messaging.dto';
import {
  MESSAGE_AUDIO_FALLBACK_BODY,
  MESSAGE_AUDIO_MAX_BYTES,
  validateAudio,
} from './message-audio';
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

/** The multer `memoryStorage()` subset an audio upload needs (no `@types/multer` dependency). */
export interface UploadedAudioFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** Voice messages — the clip metadata on an AUDIO message (`message.attachment`). No URL rides
 * along: list/realtime payloads get cached and logged, so a client resolves the clip to a
 * short-lived (15 min) presigned URL with `GET /attachments/:id/presign` at play time. */
export interface MessageAudioView {
  id: string;
  kind: 'AUDIO';
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
}

/** A message row as served to the web panel: AUDIO messages additionally carry `attachment`
 * (null when the clip cannot be resolved); TEXT messages are the unchanged row. */
export type MessageView = Message & { attachment?: MessageAudioView | null };

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
  constructor(
    private readonly repo: MessagingRepository,
    private readonly events: EventBusService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
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
    const recipients: Participant[] = [
      ...driverIds.map((id) => ({ driverId: id })),
      ...userIds.map((id) => ({ userId: id })),
    ];
    if (dto.type === 'DIRECT') {
      const existing = await this.repo.findDirectBetween(self, recipients[0]);
      if (existing) return existing;
    }
    const participants: Participant[] = [self, ...recipients];
    const conversation = await this.repo.createConversation(
      { type: dto.type, title: dto.title, createdById: actor.id },
      participants,
    );
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
  private async notifyRead(
    conversationId: string,
    reader: Participant,
    lastReadAt: Date,
  ): Promise<void> {
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
    if (!conversation)
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Conversation not found.', 404);
    const ok = await this.repo.isParticipant(conversationId, toParticipant(actor));
    if (!ok)
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Not a participant of this conversation.', 403);
    return conversation;
  }

  async listMessages(
    conversationId: string,
    actor: ContextUser,
    page: number,
    limit: number,
  ): Promise<OffsetPage<unknown>> {
    await this.assertParticipant(conversationId, actor);
    const { items: rows, total } = await this.repo.listMessages(conversationId, page, limit);
    const items = await this.withAudio(rows);
    return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async sendMessage(
    conversationId: string,
    dto: SendMessageDto,
    actor: ContextUser,
  ): Promise<MessageView> {
    const conversation = await this.assertParticipant(conversationId, actor);
    const participant = toParticipant(actor);
    const message = await this.repo.createMessage(conversationId, {
      body: dto.body,
      attachmentId: dto.attachmentId,
      clientId: dto.clientId,
      senderUserId: participant.userId,
      senderDriverId: participant.driverId,
    });
    const [view] = await this.withAudio([message]);
    await this.publishNewMessage(conversationId, conversation.participants ?? [], view);
    return view;
  }

  /**
   * Voice messages — `POST /conversations/:id/messages/audio` (multipart `file` + `durationMs`,
   * `clientId`). Stores the clip privately in object storage, then writes the Attachment
   * (kind MESSAGE_AUDIO) and an AUDIO message (`body` = plain-text fallback for clients that
   * cannot play audio) in one transaction, and pushes `message.new` like a text send. A retry
   * with the same `clientId` returns the stored message instead of uploading twice.
   */
  async sendAudioMessage(
    conversationId: string,
    file: UploadedAudioFile | undefined,
    dto: SendAudioMessageDto,
    actor: ContextUser,
  ): Promise<MessageView> {
    const conversation = await this.assertParticipant(conversationId, actor);
    const participant = toParticipant(actor);
    if (dto.clientId) {
      const existing = await this.repo.findMessageByClientId(dto.clientId);
      if (existing) {
        const sameSender =
          existing.conversationId === conversationId &&
          (existing.senderUserId ?? undefined) === participant.userId &&
          (existing.senderDriverId ?? undefined) === participant.driverId;
        if (!sameSender) {
          const message = 'clientId is already used by another message.';
          throw new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, {
            clientId: message,
          });
        }
        const [view] = await this.withAudio([existing]);
        return view;
      }
    }
    if (!file || !file.buffer?.length) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'No audio file was uploaded.', 400, {
        file: 'Required.',
      });
    }
    if (file.size > MESSAGE_AUDIO_MAX_BYTES) {
      throw new AppException(
        ERROR_CODES.FILE_TOO_LARGE,
        `Voice messages must be under ${MESSAGE_AUDIO_MAX_BYTES / 1024 / 1024} MB.`,
        422,
      );
    }
    const audio = validateAudio(file.buffer, file.mimetype);
    if (!audio) {
      throw new AppException(
        ERROR_CODES.UNSUPPORTED_FILE_TYPE,
        'Voice message must be WebM, Ogg, MP4/M4A, MP3, AAC or WAV audio.',
        422,
        { file: file.mimetype },
      );
    }

    const attachmentId = randomUUID();
    const messageId = randomUUID();
    const key = `messages/${conversationId}/${attachmentId}.${audio.extension}`;
    await this.storage.put(key, file.buffer, {
      contentType: audio.contentType,
      contentLength: file.buffer.length,
    });
    let message: Message;
    try {
      message = await this.repo.createAudioMessage(conversationId, {
        messageId,
        attachmentId,
        key,
        mimeType: audio.contentType,
        sizeBytes: file.buffer.length,
        sha256: createHash('sha256').update(file.buffer).digest('hex'),
        durationMs: dto.durationMs ?? null,
        body: MESSAGE_AUDIO_FALLBACK_BODY,
        clientId: dto.clientId,
        senderUserId: participant.userId,
        senderDriverId: participant.driverId,
        uploadedByType: actor.type === 'driver' ? 'DRIVER' : 'USER',
      });
    } catch (error) {
      // Never leave an orphaned object behind a failed write.
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
    const [view] = await this.withAudio([message]);
    await this.publishNewMessage(conversationId, conversation.participants ?? [], view);
    return view;
  }

  /** Attaches the clip metadata to every AUDIO message; TEXT rows pass
   * through untouched. One attachment query per call, not one per message. */
  async withAudio<T extends Message>(
    messages: T[],
  ): Promise<Array<T & { attachment?: MessageAudioView | null }>> {
    const audioIds = messages.filter((m) => m.type === 'AUDIO').map((m) => m.id);
    if (audioIds.length === 0) return messages;
    const attachments = await this.repo.findAudioAttachments(audioIds);
    const byMessage = new Map<string, Attachment>(
      attachments.map((a) => [a.messageId as string, a]),
    );
    return messages.map((m) => {
      if (m.type !== 'AUDIO') return m;
      const a = byMessage.get(m.id);
      if (!a || a.id !== m.attachmentId) return { ...m, attachment: null };
      return {
        ...m,
        attachment: {
          id: a.id,
          kind: 'AUDIO' as const,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          durationMs: a.durationMs,
        },
      };
    });
  }

  /** `message.new` to the conversation room (legacy subscribers) plus every staff participant's
   * auto-joined identity room — the web panel gets it without subscribing, even for a thread it
   * has never listed. One multi-room push: a socket in several of these rooms gets it once. */
  private async publishNewMessage(
    conversationId: string,
    rows: Array<{ userId: string | null; driverId: string | null }>,
    message: MessageView,
  ): Promise<void> {
    const participants: Participant[] = rows.map((p) => ({
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
  }

  /** MR-3 — tells a staff member's open sessions a driver started a thread with them. */
  async notifyConversationStarted(
    userId: string,
    conversationId: string,
    message: unknown,
  ): Promise<void> {
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
    const [liveDrivers, users] = await Promise.all([
      this.repo.findLiveDriverIds(driverIds),
      this.repo.findUserIds(userIds),
    ]);
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
      const message = await this.sendMessage(conversation.id, { body: dto.body }, actor);
      await this.notifyConversationCreated(conversation.id, participants, message, conversation);
      results.push({ conversationId: conversation.id, messageId: message.id, driverId });
    }
    return { sent: results.length, deliveries: results };
  }
}
