/** Object-storage port. Implementations: MinIO (dev) and S3 (prod) — same driver. */
export interface PutObjectOptions {
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}

export interface StoragePort {
  /** Uploads bytes and returns the stored key (prefix already applied). */
  put(key: string, body: Buffer | Uint8Array, options?: PutObjectOptions): Promise<string>;
  /**
   * Streaming multipart upload — reports (TZ §15) must never buffer a whole CSV/PDF export
   * in memory. Optional so the one lightweight `StoragePort` test mock does not need an
   * implementation; the real `S3StorageService` always provides one.
   */
  putStream?(
    key: string,
    body: NodeJS.ReadableStream,
    options?: PutObjectOptions,
  ): Promise<{ key: string; sizeBytes: number }>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Presigned PUT for direct client upload (TZ §17). `content-type` — and `content-length`
   * when `contentLength` is given — are part of the signature, so the uploader cannot swap
   * in another MIME type (e.g. `text/html`) or a larger body than was authorized (B-091). */
  presignPut(key: string, contentType: string, ttlSec?: number, contentLength?: number): Promise<string>;
  /** Presigned GET; all objects are private, default TTL 15 min (TZ §17). */
  presignGet(key: string, ttlSec?: number): Promise<string>;
}

export const STORAGE_PORT = Symbol('STORAGE_PORT');
