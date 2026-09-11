/** Object-storage port. Implementations: MinIO (dev) and S3 (prod) — same driver. */
export interface PutObjectOptions {
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface StoragePort {
  /** Uploads bytes and returns the stored key (prefix already applied). */
  put(key: string, body: Buffer | Uint8Array, options?: PutObjectOptions): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Presigned PUT for direct client upload (TZ §17). */
  presignPut(key: string, contentType: string, ttlSec?: number): Promise<string>;
  /** Presigned GET; all objects are private, default TTL 15 min (TZ §17). */
  presignGet(key: string, ttlSec?: number): Promise<string>;
}

export const STORAGE_PORT = Symbol('STORAGE_PORT');
