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
  /** Voice messages — the chat message this clip belongs to (optional so older fixtures compile). */
  messageId?: string | null;
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

  findWithOwner(id: string): Promise<AttachmentOwnerRow | null> {
    return this.prisma.attachment.findUnique({
      where: { id },
      select: {
        id: true,
        key: true,
        dvirId: true,
        defectId: true,
        ticketId: true,
        messageId: true,
        uploadedById: true,
        uploadedByType: true,
        maintenanceInvoiceFor: { select: { id: true }, take: 1 },
        dvir: { select: { driverId: true } },
        defect: { select: { dvir: { select: { driverId: true } } } },
        ticket: { select: { createdByUserId: true, createdByDriverId: true } },
      },
    });
  }

  /** Voice messages — whether the caller (staff user or driver) is a participant of the
   * conversation that holds `messageId`. */
  async isMessageParticipant(messageId: string, actor: { userId?: string; driverId?: string }): Promise<boolean> {
    const message = await this.prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
    if (!message) return false;
    const row = await this.prisma.conversationParticipant.findFirst({
      where: { conversationId: message.conversationId, ...(actor.userId ? { userId: actor.userId } : { driverId: actor.driverId }) },
      select: { id: true },
    });
    return row !== null;
  }
}
