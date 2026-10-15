import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Attachment, Message } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage } from '../../common/dto/list-query.dto';
import { PushService } from '../../core/firebase/push.service';
import { EventBusService } from '../../core/events/event-bus.service';
import type { ContextUser } from '../../core/context/request-context';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { BroadcastMessageDto, CONVERSATIONS_PAGE_MAX, CreateConversationDto, SendAudioMessageDto, SendMessageDto } from './dto/messaging.dto';
import {
  ChatAttachmentsService,
  ChatAttachmentView,
  MessageType as ChatMessageType,
} from '../attachments/chat-attachments.service';
import { needsTranscode, transcodeToM4a } from './audio-transcode';
import { MESSAGE_AUDIO_FALLBACK_BODY, MESSAGE_AUDIO_MAX_BYTES, validateAudio } from './message-audio';
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
/** A message as served to the web panel and pushed in `message.new`: `type` + `attachment`
 * come from MB-9 chat uploads (`ChatAttachmentsService.decorate`, TEXT|AUDIO|IMAGE|FILE) or, for a
 * stored AUDIO row (web voice message), from its MESSAGE_AUDIO clip (`withAudio`). */
/** `Message.clientId @unique` hit by a concurrent copy of the same send. */
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

export type MessageView = Omit<Message, 'type'> & {
  type: ChatMessageType;
  attachment: ChatAttachmentView | MessageAudioView | null;
};

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
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /** BE-24 — one bounded page (`limit`, default and max `CONVERSATIONS_PAGE_MAX`); `nextCursor` is
   * the id to pass as `cursor` for the next page, `null` on the last one. */
  async listConversations(actor: ContextUser, query: { limit?: number; cursor?: string } = {}) {
    const limit = query.limit ?? CONVERSATIONS_PAGE_MAX;
    const rows = await this.repo.listForActor(toParticipant(actor), { take: limit + 1, cursor: query.cursor });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
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

  /**
   * Idempotent send: the message already stored under `clientId` by the same sender in the same
   * conversation, or `undefined`. The same `clientId` from anyone else is a 422, never a replay
   * of their message.
   */
  private async replayByClientId(
    conversationId: string,
    clientId: string | undefined,
    participant: ReturnType<typeof toParticipant>,
  ): Promise<MessageView | undefined> {
    if (!clientId) return undefined;
    const existing = await this.repo.findMessageByClientId(clientId);
    if (!existing) return undefined;
    const sameSender =
      existing.conversationId === conversationId &&
      (existing.senderUserId ?? undefined) === participant.userId &&
      (existing.senderDriverId ?? undefined) === participant.driverId;
    if (!sameSender) {
      const message = 'clientId is already used by another message.';
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, { clientId: message });
    }
    const [view] = await this.present([existing]);
    return view;
  }

  private async assertParticipant(conversationId: string, actor: ContextUser) {
    const conversation = await this.repo.findById(conversationId);
    if (!conversation) throw new AppException(ERROR_CODES.NOT_FOUND, 'Conversation not found.', 404);
    const ok = await this.repo.isParticipant(conversationId, toParticipant(actor));
    if (!ok) throw new AppException(ERROR_CODES.FORBIDDEN, 'Not a participant of this conversation.', 403);
    return conversation;
  }

  /** Driver disable — staff cannot keep messaging a DIRECT thread whose driver is no longer
   * ACTIVE (the history stays readable). Group threads still deliver to their active members. */
  private async assertDirectDriverReachable(
    conversation: { type: string; participants?: Array<{ driverId: string | null }> },
    actor: ContextUser,
  ): Promise<void> {
    if (actor.type === 'driver' || conversation.type !== 'DIRECT') return;
    const driverIds = (conversation.participants ?? []).map((p) => p.driverId).filter((id): id is string => id !== null);
    if (driverIds.length === 0) return;
    const live = await this.repo.findLiveDriverIds(driverIds);
    if (driverIds.some((id) => !live.has(id))) {
      throw AppException.conflict('This driver is no longer active and cannot receive messages.', { driverIds });
    }
  }

  async listMessages(conversationId: string, actor: ContextUser, page: number, limit: number): Promise<OffsetPage<unknown>> {
    await this.assertParticipant(conversationId, actor);
    // deliveredAt: the reader fetching the thread is the delivery of the other side's messages.
    await this.repo.markDelivered(conversationId, toParticipant(actor)).catch(() => 0);
    const { items, total } = await this.repo.listMessages(conversationId, page, limit);
    return { items: await this.present(items), page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async sendMessage(conversationId: string, dto: SendMessageDto, actor: ContextUser) {
    const conversation = await this.assertParticipant(conversationId, actor);
    const participant = toParticipant(actor);
    // CODE-017 — a retry with the same `clientId` (web/app resend after a timeout) returns the
    // stored message instead of a 500 on `Message.clientId @unique`, exactly like the audio path.
    const replay = await this.replayByClientId(conversationId, dto.clientId, participant);
    if (replay) return replay;
    await this.assertDirectDriverReachable(conversation, actor);
    if (dto.attachmentId) await this.chatAttachments.assertSendable(dto.attachmentId, actor);
    let created: Awaited<ReturnType<MessagingRepository['createMessage']>>;
    try {
      created = await this.repo.createMessage(conversationId, {
        body: dto.body,
        attachmentId: dto.attachmentId,
        clientId: dto.clientId,
        senderUserId: participant.userId,
        senderDriverId: participant.driverId,
      });
    } catch (err) {
      // Two copies of the same send raced past the lookup: the loser replays the winner's row.
      const raced = isUniqueViolation(err) ? await this.replayByClientId(conversationId, dto.clientId, participant) : undefined;
      if (raced) return raced;
      throw err;
    }
    const [message] = await this.present([created]);
    await this.publishNewMessage(conversationId, conversation.participants ?? [], message);
    if (actor.type !== 'driver') await this.pushToDrivers(conversation, message, participant);
    return message;
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
    const replay = await this.replayByClientId(conversationId, dto.clientId, participant);
    if (replay) return replay;
    await this.assertDirectDriverReachable(conversation, actor);
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

    // WebM/Ogg (browser MediaRecorder) -> AAC/M4A so the driver app and Safari can play it. On any
    // ffmpeg failure the original clip is stored under its own, accurate mime type.
    let stored: { buffer: Buffer; contentType: string; extension: string } = { buffer: file.buffer, ...audio };
    if (needsTranscode(audio.extension)) {
      try {
        stored = await transcodeToM4a(file.buffer, audio.extension);
      } catch (err) {
        this.logger.warn(
          { conversationId, mimeType: audio.contentType, err: err instanceof Error ? err.message : String(err) },
          'Voice message transcode failed; storing the original file',
        );
      }
    }
    const attachmentId = randomUUID();
    const messageId = randomUUID();
    const key = `messages/${conversationId}/${attachmentId}.${stored.extension}`;
    await this.storage.put(key, stored.buffer, {
      contentType: stored.contentType,
      contentLength: stored.buffer.length,
    });
    let message: Message;
    try {
      message = await this.repo.createAudioMessage(conversationId, {
        messageId,
        attachmentId,
        key,
        mimeType: stored.contentType,
        sizeBytes: stored.buffer.length,
        sha256: createHash('sha256').update(stored.buffer).digest('hex'),
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
    const [view] = await this.present([message]);
    await this.publishNewMessage(conversationId, conversation.participants ?? [], view);
    if (actor.type !== 'driver') await this.pushToDrivers(conversation, view, participant);
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

  /** Builds the served view of stored rows: MB-9 chat uploads via `ChatAttachmentsService.decorate`,
   * then stored AUDIO rows (web voice messages) keep `type: 'AUDIO'` with their MESSAGE_AUDIO clip. */
  async present(messages: Message[]): Promise<MessageView[]> {
    const [decorated, audio] = await Promise.all([this.chatAttachments.decorate(messages), this.withAudio(messages)]);
    return decorated.map((m, i) =>
      messages[i].type === 'AUDIO' ? { ...m, type: 'AUDIO' as const, attachment: audio[i].attachment ?? null } : m,
    );
  }

  /** `message.new` to the conversation room (legacy subscribers) plus every staff participant's
   * auto-joined identity room — the web panel gets it without subscribing, even for a thread it has
   * never listed. One multi-room push: a socket in several of these rooms gets it once. */
  private async publishNewMessage(
    conversationId: string,
    rows: Array<{ userId: string | null; driverId: string | null }>,
    rawMessage: MessageView,
  ): Promise<void> {
    // The room is shared by the web panel and the driver app: a voice clip also carries the mobile
    // fields (`url` presigned, `durationSec`) next to the web ones (`kind`, `durationMs`) — additive.
    let message = rawMessage;
    if (rawMessage.type === 'AUDIO' && rawMessage.attachment) {
      const [mobile] = await this.chatAttachments.decorate([rawMessage]);
      if (mobile?.attachment) message = { ...rawMessage, attachment: { ...rawMessage.attachment, ...mobile.attachment } };
    }
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
    throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Some recipients were not found or are no longer active.', 422, {
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
