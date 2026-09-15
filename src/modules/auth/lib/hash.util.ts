import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 hex digest — used for refresh-token-at-rest (TZ §6.5). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Random opaque refresh-token / reset-token material (TZ §6.5 — hashed at rest). */
export function randomOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}
