import { Injectable } from '@nestjs/common';
import type { Conversation, Message, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface Participant {
  userId?: string;
  driverId?: string;
}

/** §20 B-37 — one conversation row plus its preview + the caller's own unread count. */
export type ConversationWithMeta = Conversation & {
  participants: Array<{ id: string; conversationId: string; userId: string | null; driverId: string | null; lastReadAt: Date | null; mutedUntil: Date | null }>;
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
    const unreadRows = await this.prisma.$queryRaw<Array<{ conversationId: string; count: bigint }>>`
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
    const unreadByConversation = new Map(unreadRows.map((r) => [r.conversationId, Number(r.count)]));

    return conversations.map((c) => ({
      ...c,
      lastMessage: lastMessageByConversation.get(c.id) ?? null,
      unreadCount: unreadByConversation.get(c.id) ?? 0,
    }));
  }

  /** §20 B-67 — marks the caller's own participant row read up to `readAt` (default now). */
  async markRead(conversationId: string, actor: Participant, readAt: Date = new Date()): Promise<void> {
    await this.prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        ...(actor.userId ? { userId: actor.userId } : { driverId: actor.driverId }),
      },
      data: { lastReadAt: readAt },
    });
  }

  findById(id: string) {
    return this.prisma.conversation.findUnique({ where: { id }, include: { participants: true } });
  }

  isParticipant(conversationId: string, actor: Participant): Promise<boolean> {
    return this.prisma.conversationParticipant
      .findFirst({
        where: { conversationId, ...(actor.userId ? { userId: actor.userId } : { driverId: actor.driverId }) },
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
        participants: { create: participants.map((p) => ({ userId: p.userId, driverId: p.driverId })) },
      },
      include: { participants: true },
    });
  }

  listMessages(conversationId: string, page: number, limit: number): Promise<{ items: Message[]; total: number }> {
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
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({ data: { ...data, conversation: { connect: { id: conversationId } } } }),
      this.prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } }),
    ]);
    return message;
  }
}
