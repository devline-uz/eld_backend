import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';

const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024; // 2 MB — a signature/photo is a small PNG/JPEG.

export interface StoredSignature {
  id: string;
  key: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * TZ §6 ("Signature capture and storage") / §13.2 (signature stored locally offline, then
 * queued). Bytes go to object storage (S3/MinIO, §17); only the key and a sha256 of the bytes
 * are ever persisted in Postgres — the signature image itself is never inlined into a row.
 */
@Injectable()
export class SignatureService {
  constructor(@Inject(STORAGE_PORT) private readonly storage: StoragePort) {}

  async store(
    prefix: 'signatures' | 'dvir-photos',
    driverId: string,
    base64: string,
    mimeType: string,
  ): Promise<StoredSignature> {
    const buffer = decodeBase64(base64);
    if (buffer.length === 0) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Signature payload decoded to zero bytes.', 422);
    }
    if (buffer.length > MAX_SIGNATURE_BYTES) {
      throw new AppException(ERROR_CODES.FILE_TOO_LARGE, 'Signature/photo exceeds the 2 MB limit.', 413, {
        maxBytes: MAX_SIGNATURE_BYTES,
      });
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const id = randomUUID();
    const key = `${prefix}/${driverId}/${id}.${ext}`;
    await this.storage.put(key, buffer, { contentType: mimeType, contentLength: buffer.length });
    return { id, key, sha256, sizeBytes: buffer.length };
  }
}

function decodeBase64(value: string): Buffer {
  // Accepts both a bare base64 string and a `data:image/png;base64,...` data URL.
  const comma = value.indexOf(',');
  const raw = value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value;
  return Buffer.from(raw, 'base64');
}
