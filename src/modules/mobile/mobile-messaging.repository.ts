import { Injectable } from '@nestjs/common';
import type { Message } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface RawParticipant {
  userId: string | null;
  driverId: string | null;
}

export interface ConversationSummary {
  id: string;
  type: string;
  title: string | null;
  lastMessageAt: Date | null;
  lastMessage: Message | null;
  unreadCount: number;
  rawParticipants: RawParticipant[];
}

/**
 * TZ §11.5 / mobile.tz §7.5 — MB-15 driver-facing conversation list + cursor message paging.
 * Own repository (not `MessagingRepository`, which `messaging.controller.ts` — off limits —
 * already depends on): read shapes here are driver-specific (last message + unread count,
 * cursor pagination) and would only grow the shared file for a web contract that does not use
 * them.
 */
@Injectable()
export class MobileMessagingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForDriver(driverId: string): Promise<ConversationSummary[]> {
    const participants = await this.prisma.conversationParticipant.findMany({
      where: { driverId },
      include: {
        conversation: {
          include: {
            messages: { orderBy: { sentAt: 'desc' }, take: 1 },
            participants: { select: { userId: true, driverId: true } },
          },
        },
      },
      orderBy: { conversation: { lastMessageAt: 'desc' } },
    });

    return Promise.all(
      participants.map(async (p) => {
        const conversation = p.conversation;
        const unreadCount = await this.prisma.message.count({
          where: {
            conversationId: conversation.id,
            senderDriverId: { not: driverId },
            ...(p.lastReadAt ? { sentAt: { gt: p.lastReadAt } } : {}),
          },
        });
        return {
          id: conversation.id,
          type: conversation.type,
          title: conversation.title,
          lastMessageAt: conversation.lastMessageAt,
          lastMessage: conversation.messages[0] ?? null,
          unreadCount,
          rawParticipants: conversation.participants,
        };
      }),
    );
  }

  /** Cursor pagination, newest first. `before` is a message id: results are strictly older
   *  (by `sentAt`, then `id` as a tiebreaker) than that message. */
  async listMessagesCursor(conversationId: string, limit: number, before?: string): Promise<Message[]> {
    const cursor = before ? await this.prisma.message.findUnique({ where: { id: before } }) : null;
    return this.prisma.message.findMany({
      where: {
        conversationId,
        ...(cursor ? { OR: [{ sentAt: { lt: cursor.sentAt } }, { sentAt: cursor.sentAt, id: { lt: cursor.id } }] } : {}),
      },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  /** §11.5 — sets the driver's own `lastReadAt` and stamps `readAt` on every message in the
   *  conversation they did not author. */
  async markRead(conversationId: string, driverId: string, now: Date): Promise<{ messagesMarked: number }> {
    const [, updated] = await this.prisma.$transaction([
      this.prisma.conversationParticipant.updateMany({
        where: { conversationId, driverId },
        data: { lastReadAt: now },
      }),
      this.prisma.message.updateMany({
        where: { conversationId, senderDriverId: { not: driverId }, readAt: null },
        data: { readAt: now },
      }),
    ]);
    return { messagesMarked: updated.count };
  }

  /** MR-18 — display names for message senders / participants in two batched queries. */
  async nameMaps(userIds: string[], driverIds: string[]): Promise<{ users: Map<string, string>; drivers: Map<string, string> }> {
    const [users, drivers] = await Promise.all([
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } })
        : Promise.resolve([]),
      driverIds.length
        ? this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, firstName: true, lastName: true } })
        : Promise.resolve([]),
    ]);
    return {
      users: new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()])),
      drivers: new Map(drivers.map((d) => [d.id, `${d.firstName} ${d.lastName}`.trim()])),
    };
  }

  /** MR-3 — an active staff user (the targets `GET /mobile/contacts` lists). */
  findActiveStaff(id: string): Promise<{ id: string } | null> {
    return this.prisma.user.findFirst({
      where: { id, status: 'ACTIVE', role: { key: { in: ['SUPER_ADMIN', 'ADMIN', 'FLEET_MANAGER', 'DISPATCHER'] } } },
      select: { id: true },
    });
  }

  /** MR-3 — the existing 1:1 DIRECT conversation between the driver and `other`, if any. */
  findDirectConversation(driverId: string, other: { userId?: string; driverId?: string }): Promise<{ id: string } | null> {
    const otherWhere = other.userId ? { userId: other.userId } : { driverId: other.driverId };
    return this.prisma.conversation.findFirst({
      where: {
        type: 'DIRECT',
        AND: [
          { participants: { some: { driverId } } },
          { participants: { some: otherWhere } },
          { participants: { every: { OR: [{ driverId }, otherWhere] } } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** MR-3 — the driver's own SUPPORT conversation (opened by `contactId: "support"`). */
  findSupportConversation(driverId: string): Promise<{ id: string } | null> {
    return this.prisma.conversation.findFirst({
      where: { type: 'SUPPORT', participants: { some: { driverId } } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  findMessageByClientId(clientId: string): Promise<Message | null> {
    return this.prisma.message.findUnique({ where: { clientId } });
  }
}
