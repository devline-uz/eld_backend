import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { AttachmentOwnerRow, AttachmentsRepository } from './attachments.repository';

/** TZ §17 — every presigned GET is short-lived (15 min), never the S3/MinIO PUT default. */
export const ATTACHMENT_PRESIGN_TTL_SEC = 15 * 60;

export interface PresignedUrl {
  url: string;
  expiresAt: string;
}

/**
 * §20 B-41 — reusable presign helper.
 *
 * `presignAttachment` is the authorization-checked path for `GET /attachments/:id/presign`:
 * a driver may read any file they uploaded themselves (M-39 invoice PDFs); otherwise it walks the `Attachment` row's owning DVIR/defect/support-ticket and only signs a URL
 * for a caller who may actually see that owner (the DVIR's driver, a back-office user with
 * `dvir` READ+, or — for ticket attachments — the ticket's own author or `support` READ+).
 * Unknown/unlinked attachments (message photos, fuel-purchase receipts — no read endpoint
 * exposes those yet) are refused rather than guessed at, to avoid an IDOR-by-omission.
 *
 * `presignKey` is the raw, no-authorization-check wrapper other modules can call once they
 * have already decided the caller may see the object (e.g. fleet-ops driver-document reads,
 * which key off `DriverDocument.fileKey` rather than an `Attachment` row).
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly repo: AttachmentsRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  async presignAttachment(id: string, actor: ContextUser): Promise<PresignedUrl> {
    const attachment = await this.repo.findWithOwner(id);
    if (!attachment || !this.mayView(attachment, actor)) {
      // Same 404 whether the row is missing or the caller may not see it — never confirm
      // that an attachment id belonging to someone else exists.
      throw new AppException(ERROR_CODES.ATTACHMENT_NOT_FOUND, 'Attachment not found.', 404, { id });
    }
    return this.presignKey(attachment.key);
  }

  async presignKey(key: string, ttlSec: number = ATTACHMENT_PRESIGN_TTL_SEC): Promise<PresignedUrl> {
    const url = await this.storage.presignGet(key, ttlSec);
    return { url, expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString() };
  }

  private mayView(attachment: AttachmentOwnerRow, actor: ContextUser): boolean {
    // M-39/M-41 — a driver may always read back a file THEY uploaded (maintenance invoice PDF, DVIR
    // photo not yet linked); never somebody else's.
    if (actor.type === 'driver' && attachment.uploadedByType === 'DRIVER' && attachment.uploadedById === actor.id) return true;
    // M-39 — a submitted maintenance invoice is readable from the back office with `maintenance` READ+.
    if (attachment.maintenanceInvoiceFor.length > 0 && actor.type !== 'driver') {
      return (actor.permissions?.maintenance ?? 'NONE') !== 'NONE';
    }
    const driverId = attachment.dvir?.driverId ?? attachment.defect?.dvir.driverId;
    if (driverId !== undefined) {
      if (actor.type === 'driver') return actor.id === driverId;
      return (actor.permissions?.dvir ?? 'NONE') !== 'NONE';
    }
    if (attachment.ticket) {
      if (actor.type === 'driver') return actor.id === attachment.ticket.createdByDriverId;
      if (actor.id === attachment.ticket.createdByUserId) return true;
      return (actor.permissions?.support ?? 'NONE') !== 'NONE';
    }
    // No known owner chain (e.g. message/fuel-purchase attachments) — deny by default.
    return false;
  }
}
