import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ERROR_CODES } from '../../common/errors/codes';
import { AppException } from '../../common/errors/app.exception';
import { AppConfigService } from '../config/config.service';
import { PutObjectOptions, StoragePort } from './storage.port';

/**
 * S3-compatible adapter, used against MinIO in dev and S3 in prod.
 * TZ §27.1 point 5: every key goes through `withPrefix()` so a tenant prefix can be
 * introduced later without touching call sites.
 */
@Injectable()
export class S3StorageService implements StoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly defaultTtl: number;

  constructor(config: AppConfigService) {
    this.bucket = config.get('S3_BUCKET');
    this.prefix = config.get('S3_KEY_PREFIX');
    this.defaultTtl = config.get('S3_PRESIGN_TTL_SEC');
    const accessKeyId = config.get('S3_ACCESS_KEY');
    const secretAccessKey = config.get('S3_SECRET_KEY');
    this.client = new S3Client({
      region: config.get('S3_REGION'),
      endpoint: config.get('S3_ENDPOINT'),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE'),
      credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
      // B-091 — SDK >= 3.729 otherwise bakes a CRC32 of the *empty* body into every presigned
      // PUT URL (`x-amz-checksum-crc32=AAAAAA==`), so a real upload fails with BadDigest.
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  private withPrefix(key: string): string {
    return this.prefix ? `${this.prefix.replace(/\/$/, '')}/${key}` : key;
  }

  async put(key: string, body: Buffer | Uint8Array, options?: PutObjectOptions): Promise<string> {
    const finalKey = this.withPrefix(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: finalKey,
        Body: body,
        ContentType: options?.contentType,
        ContentLength: options?.contentLength,
        Metadata: options?.metadata,
      }),
    );
    return finalKey;
  }

  /** TZ §15 — multipart streaming upload; the caller's readable stream is piped straight to
   * S3/MinIO in chunks, so a million-row CSV/PDF export never sits fully in process memory. */
  async putStream(
    key: string,
    body: NodeJS.ReadableStream,
    options?: PutObjectOptions,
  ): Promise<{ key: string; sizeBytes: number }> {
    const finalKey = this.withPrefix(key);
    let sizeBytes = 0;
    body.on('data', (chunk: Buffer) => {
      sizeBytes += chunk.length;
    });
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: finalKey,
        // `@aws-sdk/lib-storage`'s `StreamingBlobPayloadInputTypes` wants a concrete
        // `stream.Readable`, not just the `NodeJS.ReadableStream` interface this port takes
        // (any readable — e.g. a `PassThrough` — satisfies both at runtime; only the type
        // matches differ after the 3.1130 SDK bump).
        Body: body as unknown as import('node:stream').Readable,
        ContentType: options?.contentType,
        Metadata: options?.metadata,
      },
    });
    await upload.done();
    return { key: finalKey, sizeBytes };
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.withPrefix(key) }),
    );
    if (!res.Body) {
      throw new AppException(ERROR_CODES.STORAGE_UNAVAILABLE, `Empty object body for "${key}".`);
    }
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.withPrefix(key) }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.withPrefix(key) }),
      );
      return true;
    } catch {
      return false;
    }
  }

  presignPut(key: string, contentType: string, ttlSec?: number, contentLength?: number): Promise<string> {
    // B-091 — without `signableHeaders` the presigner signs only `host`: the uploader could
    // PUT any Content-Type (stored XSS via `text/html` served from the bucket origin) and
    // any size. Binding both headers makes S3/MinIO reject a mismatching upload.
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.withPrefix(key),
        ContentType: contentType,
        ...(contentLength !== undefined && { ContentLength: contentLength }),
      }),
      {
        expiresIn: ttlSec ?? this.defaultTtl,
        signableHeaders: new Set(['content-type', ...(contentLength !== undefined ? ['content-length'] : [])]),
      },
    );
  }

  presignGet(key: string, ttlSec?: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.withPrefix(key) }),
      { expiresIn: ttlSec ?? this.defaultTtl },
    );
  }

  /** Storage reachability probe for /health/deep. */
  async ping(): Promise<boolean> {
    await this.presignGet('__healthcheck__', 60);
    return true;
  }
}
