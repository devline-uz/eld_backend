import { Injectable } from '@nestjs/common';
import type { Feedback, Prisma, SupportTicket } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface TicketListFilter {
  status?: SupportTicket['status'];
  priority?: SupportTicket['priority'];
  q?: string;
}

export interface TicketListPage {
  items: SupportTicket[];
  total: number;
}

/** TZ §5.10, §11.7 — support tickets and in-app feedback. */
@Injectable()
export class SupportRepository extends BaseRepository<
  SupportTicket,
  Prisma.SupportTicketWhereInput,
  Prisma.SupportTicketWhereUniqueInput,
  Prisma.SupportTicketCreateInput,
  Prisma.SupportTicketUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    SupportTicket,
    Prisma.SupportTicketWhereInput,
    Prisma.SupportTicketWhereUniqueInput,
    Prisma.SupportTicketCreateInput,
    Prisma.SupportTicketUpdateInput
  > {
    return this.prisma.supportTicket;
  }

  async list(
    filter: TicketListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<TicketListPage> {
    const where: Prisma.SupportTicketWhereInput = {
      ...(filter.status && { status: filter.status }),
      ...(filter.priority && { priority: filter.priority }),
      ...(filter.q && {
        OR: [
          { number: { contains: filter.q, mode: 'insensitive' } },
          { subject: { contains: filter.q, mode: 'insensitive' } },
          { category: { contains: filter.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.supportTicket.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return { items, total };
  }

  createFeedback(data: Prisma.FeedbackCreateInput): Promise<Feedback> {
    return this.prisma.feedback.create({ data });
  }
}
