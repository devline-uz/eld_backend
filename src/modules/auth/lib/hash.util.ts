import { createHash } from 'node:crypto';

/** SHA-256 hex digest — used for refresh-token-at-rest (TZ §6.5) and recovery codes. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
