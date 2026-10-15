import { Injectable } from '@nestjs/common';
import type { Attachment, Conversation, EditorType, Message, Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../core/prisma/prisma.service';
import { MESSAGE_AUDIO_KIND } from './message-audio';

export interface Participant {
  userId?: string;
  driverId?: string;
}

/** Voice messages — one stored clip plus the message that carries it, written together. */
export interface NewAudioMessage {
  messageId: string;
  attachmentId: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  durationMs: number | null;
  body: string;
  clientId?: string;
  senderUserId?: string;
  senderDriverId?: string;
  uploadedByType: EditorType;
}

/** §20 B-37 — one conversation row plus its preview + the caller's own unread count. */
export type ConversationWithMeta = Conversation & {
  participants: Array<{
    id: string;
    conversationId: string;
    userId: string | null;
    driverId: string | null;
    lastReadAt: Date | null;
    mutedUntil: Date | null;
  }>;
  lastMessage: Message | null;
  unreadCount: number;
};

@Injectable()
export class MessagingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** BE-24 — at most `page.take` conversations, newest activity first (`id` breaks ties so the
   * `cursor` — the last id of the previous page — pages stably). */
  async listForActor(actor: Participant, page: { take?: number; cursor?: string } = {}): Promise<ConversationWithMeta[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        participants: {
          some: actor.userId ? { userId: actor.userId } : { driverId: actor.driverId },
        },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      ...(page.take !== undefined && { take: page.take }),
      ...(page.cursor && { cursor: { id: page.cursor }, skip: 1 }),
      include: { participants: true },
    });
    if (!conversations.length) return [];
    const ids = conversations.map((c) => c.id);

    // §20 B-37 — one query for every conversation's newest message (Postgres DISTINCT ON via
    // Prisma's `distinct`), not one query per row.
    const lastMessages = await this.prisma.message.findMany({
      where: { conversationId: { in: ids } },
      orderBy: [{ conversationId: 'asc' }, { sentAt: 'desc' }],
      distinct: ['conversationId'],
    });
    const lastMessageByConversation = new Map(lastMessages.map((m) => [m.conversationId, m]));

    // §20 B-37 — one raw aggregate for every conversation's real unread count (messages sent
    // after the caller's own `ConversationParticipant.lastReadAt`), not one COUNT per row.
    const unreadRows = await this.prisma.$queryRaw<
      Array<{ conversationId: string; count: bigint }>
    >`
      SELECT m."conversationId" AS "conversationId", COUNT(*) AS count
      FROM "Message" m
      JOIN "ConversationParticipant" cp
        ON cp."conversationId" = m."conversationId"
        AND (
          (${actor.userId ?? null}::text IS NOT NULL AND cp."userId" = ${actor.userId ?? null})
          OR (${actor.driverId ?? null}::text IS NOT NULL AND cp."driverId" = ${actor.driverId ?? null})
        )
      WHERE m."conversationId" = ANY(${ids})
        AND m."sentAt" > COALESCE(cp."lastReadAt", '-infinity'::timestamp)
      GROUP BY m."conversationId"
    `;
    const unreadByConversation = new Map(
      unreadRows.map((r) => [r.conversationId, Number(r.count)]),
    );

    return conversations.map((c) => ({
      ...c,
      lastMessage: lastMessageByConversation.get(c.id) ?? null,
      unreadCount: unreadByConversation.get(c.id) ?? 0,
    }));
  }

  /** Prisma `{ not: x }` drops NULL rows (SQL `<>`), so "not sent by `actor`" is spelled out. */
  private notSentBy(actor: Participant): Prisma.MessageWhereInput {
    return actor.userId
      ? { OR: [{ senderUserId: null }, { senderUserId: { not: actor.userId } }] }
      : { OR: [{ senderDriverId: null }, { senderDriverId: { not: actor.driverId } }] };
  }

  /**
   * §20 B-67 — marks the caller's own participant row read up to `readAt` (default now) AND stamps
   * `readAt` (plus `deliveredAt` when still null) on every message the caller did not send.
   * Returns the newest such message id (the `lastReadMessageId` of the `message.read` event).
   */
  async markRead(conversationId: string, actor: Participant, readAt: Date = new Date()): Promise<{ lastReadMessageId: string | null }> {
    const others = { conversationId, ...this.notSentBy(actor) };
    await this.prisma.$transaction([
      this.prisma.conversationParticipant.updateMany({
        where: { conversationId, ...(actor.userId ? { userId: actor.userId } : { driverId: actor.driverId }) },
        data: { lastReadAt: readAt },
      }),
      this.prisma.message.updateMany({ where: { ...others, deliveredAt: null }, data: { deliveredAt: readAt } }),
      this.prisma.message.updateMany({ where: { ...others, readAt: null }, data: { readAt } }),
    ]);
    const last = await this.prisma.message.findFirst({
      where: others,
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return { lastReadMessageId: last?.id ?? null };
  }

  /** `deliveredAt` = first time the recipient side fetched the thread. One cheap updateMany. */
  async markDelivered(conversationId: string, recipient: Participant, now: Date = new Date()): Promise<number> {
    const res = await this.prisma.message.updateMany({
      where: { conversationId, deliveredAt: null, ...this.notSentBy(recipient) },
      data: { deliveredAt: now },
    });
    return res.count;
  }

  async findUserDisplayName(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return u ? `${u.firstName} ${u.lastName}`.trim() || null : null;
  }

  /** BE-010 — which of `ids` are live (not soft-deleted) drivers. Web `POST /conversations` /
   * `/messages/broadcast` only; the mobile chat never calls it. */
  /** Recipients a staff member may start a thread with / message: live AND ACTIVE drivers. An
   * INACTIVE / TERMINATED driver keeps their history but cannot be messaged (no app access). */
  async findLiveDriverIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.driver.findMany({
      where: { id: { in: ids }, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** BE-010 — which of `ids` are existing panel users. */
  async findUserIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** BE-012 — the existing 1:1 DIRECT conversation between exactly `a` and `b`, if any (web). */
  findDirectBetween(a: Participant, b: Participant, db: Pick<Prisma.TransactionClient, 'conversation'> = this.prisma) {
    const whereOf = (p: Participant) =>
      p.userId ? { userId: p.userId } : { driverId: p.driverId };
    return db.conversation.findFirst({
      where: {
        type: 'DIRECT',
        AND: [
          { participants: { some: whereOf(a) } },
          { participants: { some: whereOf(b) } },
          { participants: { every: { OR: [whereOf(a), whereOf(b)] } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: { participants: true },
    });
  }

  findById(id: string) {
    return this.prisma.conversation.findUnique({ where: { id }, include: { participants: true } });
  }

  isParticipant(conversationId: string, actor: Participant): Promise<boolean> {
    return this.prisma.conversationParticipant
      .findFirst({
        where: {
          conversationId,
          ...(actor.userId ? { userId: actor.userId } : { driverId: actor.driverId }),
        },
      })
      .then((row) => row !== null);
  }

  createConversation(
    data: Prisma.ConversationCreateInput,
    participants: Participant[],
  ): Promise<Conversation> {
    const create = (db: Pick<Prisma.TransactionClient, 'conversation'>) =>
      db.conversation.create({
        data: {
          ...data,
          participants: {
            create: participants.map((p) => ({ userId: p.userId, driverId: p.driverId })),
          },
        },
        include: { participants: true },
      });
    if (data.type !== 'DIRECT' || participants.length !== 2) return create(this.prisma);
    // LIVE-026 — two quick "New message" clicks (or two tabs) both missed `findDirectBetween`
    // and created two 1:1 threads with the same driver. The pair is serialised with an advisory
    // lock and re-checked inside the transaction, so the loser gets the winner's thread.
    const [a, b] = participants;
    const key = `dm:${[participantKey(a), participantKey(b)].sort().join('|')}`;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, key);
      return (await this.findDirectBetween(a, b, tx)) ?? create(tx);
    });
  }

  listMessages(
    conversationId: string,
    page: number,
    limit: number,
  ): Promise<{ items: Message[]; total: number }> {
    return Promise.all([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.message.count({ where: { conversationId } }),
    ]).then(([items, total]) => ({ items, total }));
  }

  async createMessage(conversationId: string, data: Prisma.MessageCreateWithoutConversationInput): Promise<Message> {
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({ data: { ...data, conversation: { connect: { id: conversationId } } } });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
      // MB-9 — claim the chat upload for this message (one message per attachment; also what
      // `GET /attachments/:id/presign` keys the participant check on).
      if (message.attachmentId) {
        const claimed = await tx.attachment.updateMany({ where: { id: message.attachmentId, messageId: null }, data: { messageId: message.id } });
        if (claimed.count !== 1) throw AppException.conflict('Attachment is already used by another message.', { attachmentId: message.attachmentId });
      }
      return message;
    });
  }

  /** Voice messages — the MESSAGE_AUDIO attachments linked to `messageIds` (both directions of the
   * link must agree, so a message cannot borrow another message's / a DVIR's file by id). */
  findAudioAttachments(messageIds: string[]): Promise<Attachment[]> {
    if (messageIds.length === 0) return Promise.resolve([]);
    return this.prisma.attachment.findMany({
      where: { messageId: { in: messageIds }, kind: MESSAGE_AUDIO_KIND },
    });
  }

  /** Idempotent retry of a voice message — the message already stored under this `clientId`. */
  findMessageByClientId(clientId: string): Promise<Message | null> {
    return this.prisma.message.findUnique({ where: { clientId } });
  }

  /** Voice messages — the Attachment row, the AUDIO message and the conversation's
   * `lastMessageAt` in one transaction (the object is already in storage). */
  async createAudioMessage(conversationId: string, data: NewAudioMessage): Promise<Message> {
    const uploader = data.senderDriverId ?? data.senderUserId ?? null;
    const [, message] = await this.prisma.$transaction([
      this.prisma.attachment.create({
        data: {
          id: data.attachmentId,
          key: data.key,
          mimeType: data.mimeType,
          sizeBytes: data.sizeBytes,
          sha256: data.sha256,
          durationMs: data.durationMs,
          kind: MESSAGE_AUDIO_KIND,
          messageId: data.messageId,
          uploadedById: uploader,
          uploadedByType: data.uploadedByType,
        },
      }),
      this.prisma.message.create({
        data: {
          id: data.messageId,
          type: 'AUDIO',
          body: data.body,
          attachmentId: data.attachmentId,
          clientId: data.clientId,
          senderUserId: data.senderUserId,
          senderDriverId: data.senderDriverId,
          conversation: { connect: { id: conversationId } },
        },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      }),
    ]);
    return message;
  }
}

function participantKey(p: Participant): string {
  return p.userId ? `u:${p.userId}` : `d:${p.driverId ?? ''}`;
}
