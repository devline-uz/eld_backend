import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { DriverSavedSignature, Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import type { SavedSignatureDto } from './dto/mobile.dto';
import { MobileCatalogRepository } from './mobile-catalog.repository';
import { MobileRepository } from './mobile.repository';
import { MAX_SIGNATURE_BYTES, SignatureService } from './signature.service';

const PRESIGN_TTL_SEC = 15 * 60;
const LEDGER_TYPE = 'saved_signature';

export interface SavedSignatureView {
  signatureImageId: string;
  key: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  updatedAt: Date;
}

/**
 * MR-27 — the driver's saved (reusable) signature, one per driver. Bytes live in object storage
 * under `signatures/{driverId}/{id}.{png|jpg}` (same layout as `POST /mobile/signature`); only the
 * key + sha256 are persisted. Objects are never deleted on replace/delete: a saved key may be the
 * very object an earlier DVIR / certification already references.
 */
@Injectable()
export class MobileSavedSignatureService {
  constructor(
    private readonly repo: MobileCatalogRepository,
    private readonly mobileRepo: MobileRepository,
    private readonly signatures: SignatureService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  async get(driverId: string): Promise<SavedSignatureView | null> {
    const row = await this.repo.getSavedSignature(driverId);
    return row ? this.toView(row) : null;
  }

  async put(driverId: string, dto: SavedSignatureDto): Promise<SavedSignatureView> {
    if (dto.clientId) {
      const prior = await this.mobileRepo.findSyncedByClientId(driverId, dto.clientId);
      // The ledger is shared by sync / chat / support / vehicle release (B-122): a clientId spent on
      // another operation is never answered with that operation's result.
      if (prior && prior.type !== LEDGER_TYPE) {
        throw AppException.conflict('clientId already used by another operation.', { clientId: dto.clientId });
      }
      if (prior?.status === 'ACCEPTED' && prior.result) {
        const stored = prior.result as unknown as Omit<SavedSignatureView, 'url' | 'updatedAt'> & { updatedAt: string };
        return { ...stored, updatedAt: new Date(stored.updatedAt), url: await this.storage.presignGet(stored.key, PRESIGN_TTL_SEC) };
      }
    }

    const data = dto.signatureBase64
      ? await this.storeBytes(driverId, dto.signatureBase64, dto.mimeType ?? 'image/png')
      : await this.adoptExisting(driverId, dto.signatureImageId as string);
    const row = await this.repo.upsertSavedSignature(driverId, data);
    const view = await this.toView(row);

    if (dto.clientId) {
      const result = {
        signatureImageId: view.signatureImageId,
        key: view.key,
        mimeType: view.mimeType,
        sizeBytes: view.sizeBytes,
        sha256: view.sha256,
        updatedAt: view.updatedAt.toISOString(),
      } satisfies Record<string, Prisma.InputJsonValue>;
      await this.mobileRepo.recordSyncedResult(driverId, dto.clientId, LEDGER_TYPE, new Date(), 'ACCEPTED', null, result);
    }
    return view;
  }

  /** `{deleted:true}` even when nothing was saved — DELETE is idempotent. */
  async remove(driverId: string): Promise<{ deleted: boolean }> {
    const prior = await this.repo.deleteSavedSignature(driverId);
    return { deleted: Boolean(prior) };
  }

  private async storeBytes(driverId: string, base64: string, mimeType: string) {
    const stored = await this.signatures.store('signatures', driverId, base64, mimeType);
    return { key: stored.key, sha256: stored.sha256, mimeType, sizeBytes: stored.sizeBytes };
  }

  /** A `signatureImageId` minted by `POST /mobile/signature`: the object must exist under this driver's prefix. */
  private async adoptExisting(driverId: string, id: string) {
    for (const [ext, mimeType] of [['png', 'image/png'], ['jpg', 'image/jpeg']] as const) {
      const key = `signatures/${driverId}/${id}.${ext}`;
      if (!(await this.storage.exists(key))) continue;
      const bytes = await this.storage.get(key);
      if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'The referenced signature is empty or larger than 2 MB.', 422, { signatureImageId: id });
      }
      return { key, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType, sizeBytes: bytes.length };
    }
    throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'signatureImageId does not reference a signature uploaded by this driver.', 422, { signatureImageId: id });
  }

  private async toView(row: DriverSavedSignature): Promise<SavedSignatureView> {
    const name = row.key.split('/').pop() ?? row.key;
    return {
      signatureImageId: name.replace(/\.[^.]+$/, ''),
      key: row.key,
      url: await this.storage.presignGet(row.key, PRESIGN_TTL_SEC),
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      updatedAt: row.updatedAt,
    };
  }
}
