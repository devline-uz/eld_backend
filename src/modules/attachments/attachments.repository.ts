import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

/** Just enough of the owning chain to decide who may see the file (§20 B-41). */
export interface AttachmentOwnerRow {
  id: string;
  key: string;
  dvirId: string | null;
  defectId: string | null;
  ticketId: string | null;
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
        dvir: { select: { driverId: true } },
        defect: { select: { dvir: { select: { driverId: true } } } },
        ticket: { select: { createdByUserId: true, createdByDriverId: true } },
      },
    });
  }
}
