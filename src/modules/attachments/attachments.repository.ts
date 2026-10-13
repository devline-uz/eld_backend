import { Injectable } from '@nestjs/common';
import type { EditorType } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

/** Just enough of the owning chain to decide who may see the file (§20 B-41). */
export interface AttachmentOwnerRow {
  id: string;
  key: string;
  dvirId: string | null;
  defectId: string | null;
  ticketId: string | null;
  /** MB-9 — chat attachments: `kind` CHAT_*, linked once a message carries it. */
  kind: string | null;
  messageId: string | null;
  /** MB-9 — the participants of the message's conversation (the only readers of a linked chat file). */
  message: { conversation: { participants: Array<{ userId: string | null; driverId: string | null }> } } | null;
  /** M-39 — who uploaded it (a driver's own `POST /mobile/signature` upload, or a user). */
  uploadedById: string | null;
  uploadedByType: EditorType;
  /** M-39 — maintenance schedules this file is the submitted invoice of (id only). */
  maintenanceInvoiceFor: Array<{ id: string }>;
  dvir: { driverId: string } | null;
  defect: { dvir: { driverId: string } } | null;
  ticket: { createdByUserId: string | null; createdByDriverId: string | null } | null;
}

@Injectable()
export class AttachmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findWithOwner(id: string): Promise<AttachmentOwnerRow | null> {
    const row = await this.prisma.attachment.findUnique({
      where: { id },
      select: {
        id: true,
        key: true,
        dvirId: true,
        defectId: true,
        ticketId: true,
        kind: true,
        messageId: true,
        uploadedById: true,
        uploadedByType: true,
        maintenanceInvoiceFor: { select: { id: true }, take: 1 },
        dvir: { select: { driverId: true } },
        defect: { select: { dvir: { select: { driverId: true } } } },
        ticket: { select: { createdByUserId: true, createdByDriverId: true } },
      },
    });
    if (!row) return null;
    // MB-9 — `Attachment.messageId` is a plain column (no relation): one extra lookup, only for linked chat files.
    const msg = row.messageId
      ? await this.prisma.message.findUnique({
          where: { id: row.messageId },
          select: { conversation: { select: { participants: { select: { userId: true, driverId: true } } } } },
        })
      : null;
    return { ...row, message: msg };
  }

  createChat(data: {
    id: string; key: string; mimeType: string; sizeBytes: number; sha256: string; kind: string;
    durationSec: number | null; uploadedById: string; uploadedByType: EditorType;
  }) {
    return this.prisma.attachment.create({ data });
  }

  findChatForSend(id: string) {
    return this.prisma.attachment.findFirst({
      where: { id, kind: { in: ['CHAT_AUDIO', 'CHAT_FILE'] } },
      select: { id: true, uploadedById: true, uploadedByType: true, messageId: true },
    });
  }

  findChatByIds(ids: string[]) {
    return this.prisma.attachment.findMany({
      where: { id: { in: ids }, kind: { in: ['CHAT_AUDIO', 'CHAT_FILE'] } },
      select: { id: true, key: true, kind: true, mimeType: true, sizeBytes: true, durationSec: true },
    });
  }
}
