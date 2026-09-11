import { Injectable } from '@nestjs/common';
import type { Feedback, Prisma, SupportTicket } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { CreateFeedbackDto, CreateSupportTicketDto, SupportTicketListQueryDto, UpdateSupportTicketDto } from './dto/support.dto';
import { SupportRepository } from './support.repository';

const SORTABLE_FIELDS = ['createdAt', 'priority', 'status', 'number'] as const;

export interface RequesterContext {
  id: string;
  type: 'user' | 'driver';
}

/** TZ §5.10, §11.7 — support tickets (gated by `support`) and in-app feedback. */
@Injectable()
export class SupportService {
  constructor(private readonly repo: SupportRepository) {}

  async list(query: SupportTicketListQueryDto): Promise<OffsetPage<SupportTicket>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { createdAt: 'desc' });
    const { items, total } = await this.repo.list(
      { status: query.status, priority: query.priority, q: query.q },
      query.page,
      query.limit,
      orderBy,
    );
    return toOffsetPage(items, total, query.page, query.limit);
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
