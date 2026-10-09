import { Injectable } from '@nestjs/common';
import type { Attachment } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * mobile/tz.md §21 MB-6 — DVIR photo attachments. `POST /mobile/signature {purpose:'DVIR_PHOTO'}`
 * must leave an `Attachment` row behind (id = the returned `signatureImageId`), otherwise the
 * `defects[].photoAttachmentIds` the app sends with `POST /mobile/dvir` point at nothing and
 * `Defect.photos` can never be linked. Own repository so the shared `MobileRepository` is not grown.
 */
@Injectable()
export class DvirPhotosRepository {
  constructor(private readonly prisma: PrismaService) {}

  createPhoto(input: { id: string; key: string; mimeType: string; sizeBytes: number; sha256: string; driverId: string; kind?: string }): Promise<Attachment> {
    return this.prisma.attachment.create({
      data: {
        id: input.id,
        key: input.key,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        kind: input.kind ?? null,
        uploadedById: input.driverId,
        uploadedByType: 'DRIVER',
      },
    });
  }

  /** Photos the driver uploaded themselves and that are not yet attached to any defect. */
  findLinkable(ids: string[], driverId: string): Promise<{ id: string }[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.attachment.findMany({
      // `kind: null` — an INVOICE upload (M-39) is the same driver's attachment but never a DVIR photo.
      where: { id: { in: ids }, uploadedById: driverId, uploadedByType: 'DRIVER', defectId: null, kind: null },
      select: { id: true },
    });
  }

  countByDvir(dvirId: string): Promise<number> {
    return this.prisma.attachment.count({ where: { dvirId, defectId: { not: null } } });
  }
}
