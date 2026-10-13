import { Injectable } from '@nestjs/common';
import type { Attachment, Conversation, EditorType, Message, Prisma } from '@prisma/client';
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

  async listForActor(actor: Participant): Promise<ConversationWithMeta[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        participants: {
          some: actor.userId ? { userId: actor.userId } : { driverId: actor.driverId },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
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

  /** §20 B-67 — marks the caller's own participant row read up to `readAt` (default now). */
  async markRead(
    conversationId: string,
    actor: Participant,
    readAt: Date = new Date(),
  ): Promise<void> {
    await this.prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        ...(actor.userId ? { userId: actor.userId } : { driverId: actor.driverId }),
      },
      data: { lastReadAt: readAt },
    });
  }

  /** BE-010 — which of `ids` are live (not soft-deleted) drivers. Web `POST /conversations` /
   * `/messages/broadcast` only; the mobile chat never calls it. */
  async findLiveDriverIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.driver.findMany({
      where: { id: { in: ids }, deletedAt: null },
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
  findDirectBetween(a: Participant, b: Participant) {
    const whereOf = (p: Participant) =>
      p.userId ? { userId: p.userId } : { driverId: p.driverId };
    return this.prisma.conversation.findFirst({
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
    return this.prisma.conversation.create({
      data: {
        ...data,
        participants: {
          create: participants.map((p) => ({ userId: p.userId, driverId: p.driverId })),
        },
      },
      include: { participants: true },
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

  async createMessage(
    conversationId: string,
    data: Prisma.MessageCreateWithoutConversationInput,
  ): Promise<Message> {
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: { ...data, conversation: { connect: { id: conversationId } } },
      }),
      this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      }),
    ]);
    return message;
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
