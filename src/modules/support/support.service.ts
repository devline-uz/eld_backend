import { Injectable } from '@nestjs/common';
import type { Feedback, Prisma, SupportTicket } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { MessagingRepository } from '../messaging/messaging.repository';
import { MessagingService } from '../messaging/messaging.service';
import { CreateFeedbackDto, CreateSupportChatDto, CreateSupportTicketDto, SupportTicketListQueryDto, UpdateSupportTicketDto } from './dto/support.dto';
import { SupportRepository } from './support.repository';
import { TicketAttachmentsService } from './ticket-attachments.service';

const SORTABLE_FIELDS = ['createdAt', 'priority', 'status', 'number'] as const;

export interface RequesterContext {
  id: string;
  type: 'user' | 'driver';
}

/** TZ §5.10, §11.7 — support tickets (gated by `support`) and in-app feedback. */
@Injectable()
export class SupportService {
  constructor(
    private readonly repo: SupportRepository,
    private readonly attachments: TicketAttachmentsService,
    private readonly messagingRepo: MessagingRepository,
    private readonly messaging: MessagingService,
  ) {}

  /** Each row carries `requesterName` (the ticket's user or driver) for the web OPENED BY column. */
  async list(query: SupportTicketListQueryDto): Promise<OffsetPage<SupportTicket & { requesterName: string | null }>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { createdAt: 'desc' });
    const { items, total } = await this.repo.list(
      { status: query.status, priority: query.priority, q: query.q },
      query.page,
      query.limit,
      orderBy,
    );
    const userIds = [...new Set(items.map((t) => t.createdByUserId).filter((id): id is string => Boolean(id)))];
    const driverIds = [...new Set(items.map((t) => t.createdByDriverId).filter((id): id is string => Boolean(id)))];
    const names = await this.repo.requesterNames(userIds, driverIds);
    const rows = items.map((t) => ({
      ...t,
      requesterName: names.get(t.createdByUserId ?? t.createdByDriverId ?? '') ?? null,
    }));
    return toOffsetPage(rows, total, query.page, query.limit);
  }

  async get(id: string): Promise<SupportTicket> {
    const ticket = await this.repo.findById({ id });
    if (!ticket) throw AppException.notFound('Support ticket not found.');
    return ticket;
  }

  /** Retries on a `number` unique-constraint collision (concurrent creates racing the same
   * count-based sequence) — up to a handful of attempts, which is more than enough headroom
   * for realistic write rates on this table. */
  async create(dto: CreateSupportTicketDto, requester: RequesterContext): Promise<SupportTicket> {
    const ticket = await this.createTicketRow(dto, requester);
    // §20 B-91 — collected after the ticket exists (attachments FK to ticketId); best-effort,
    // never blocks the ticket itself.
    if (dto.attachments?.length) {
      await this.attachments.collect(ticket.id, dto.vehicleId, dto.attachments.map((a) => a.kind));
    }
    return ticket;
  }

  private async createTicketRow(dto: CreateSupportTicketDto, requester: RequesterContext): Promise<SupportTicket> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const number = await this.nextTicketNumber();
      try {
        return await this.repo.create({
          number,
          subject: dto.subject,
          body: dto.body,
          category: dto.category,
          priority: dto.priority,
          ...(requester.type === 'driver' ? { createdByDriverId: requester.id } : { createdByUserId: requester.id }),
        });
      } catch (err) {
        if (!isUniqueConstraintError(err) || attempt === 4) throw err;
      }
    }
    /* unreachable */
    throw new Error('Failed to allocate a support ticket number.');
  }

  /** §20 B-90 — opens (or continues) a real-time support conversation. Reuses
   * `Conversation`/`Message` (`type: 'SUPPORT'`) and the existing socket room plumbing
   * (`conversation:{id}`, wired by `MessagingService.sendMessage`) rather than a bespoke chat
   * model/provider integration. */
  async createChat(dto: CreateSupportChatDto, requester: RequesterContext) {
    const participant = requester.type === 'driver' ? { driverId: requester.id } : { userId: requester.id };
    const conversation = await this.messagingRepo.createConversation(
      { type: 'SUPPORT', title: dto.subject ?? 'Support chat', createdById: requester.id },
      [participant],
    );
    const message = await this.messaging.sendMessage(conversation.id, { body: dto.message }, requester);
    return { conversationId: conversation.id, messageId: message.id };
  }

  async update(id: string, dto: UpdateSupportTicketDto): Promise<SupportTicket> {
    await this.get(id);
    return this.repo.update(
      { id },
      {
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.assignedToId !== undefined && { assignedToId: dto.assignedToId }),
        ...(dto.status === 'RESOLVED' || dto.status === 'CLOSED' ? { resolvedAt: new Date() } : {}),
      },
    );
  }

  createFeedback(dto: CreateFeedbackDto, requester: RequesterContext): Promise<Feedback> {
    return this.repo.createFeedback({
      answers: dto.answers as Prisma.InputJsonValue,
      comment: dto.comment,
      appVersion: dto.appVersion,
      platform: dto.platform,
      ...(requester.type === 'driver' ? { driverId: requester.id } : { userId: requester.id }),
    });
  }

  /** `TCK-000123` — zero-padded, monotonically increasing with the row count. Collisions are
   * effectively impossible under normal write rates; a retry-on-conflict is unnecessary since
   * `number` has no external meaning beyond "human-readable ticket reference". */
  private async nextTicketNumber(): Promise<string> {
    const count = await this.repo.count();
    return `TCK-${String(count + 1).padStart(6, '0')}`;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
