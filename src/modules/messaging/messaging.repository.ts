import { Injectable } from '@nestjs/common';
import type { Conversation, Message, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface Participant {
  userId?: string;
  driverId?: string;
}

@Injectable()
export class MessagingRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForActor(actor: Participant): Promise<Conversation[]> {
    return this.prisma.conversation.findMany({
      where: {
        participants: {
          some: actor.userId ? { userId: actor.userId } : { driverId: actor.driverId },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
      include: { participants: true },
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
