import { Injectable } from '@nestjs/common';
import type { Attachment, EldEvent } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface CreateTicketAttachmentInput {
  key: string;
  mimeType: string;
  sizeBytes: number;
  ticketId: string;
  kind: 'DEVICE_DIAGNOSTICS' | 'ELD_EVENTS_24H';
}

/** §20 B-91 — the two DB accesses `TicketAttachmentsService` needs (writing the `Attachment`
 * row, reading the last 24h of `EldEvent`s for a vehicle), kept out of the service per TZ §3.5
 * (controller -> service -> repository; DB access only in repositories). */
@Injectable()
export class TicketAttachmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  createAttachment(input: CreateTicketAttachmentInput): Promise<Attachment> {
    return this.prisma.attachment.create({
      data: {
        key: input.key,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        ticketId: input.ticketId,
        kind: input.kind,
        uploadedByType: 'SYSTEM',
      },
    });
  }

  findEldEvents24h(vehicleId: string, from: Date, to: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { vehicleId, eventDateTime: { gte: from, lte: to } },
      orderBy: { eventDateTime: 'asc' },
      take: 5000,
    });
  }
}
