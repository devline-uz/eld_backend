import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * TZ §16 — AES-256-GCM, authenticated encryption for `Integration.config` secrets at rest.
 * Payload format: `v1:<iv base64>:<authTag base64>:<ciphertext base64>`. A fresh random IV is
 * generated per call, per FIPS/NIST SP 800-38D guidance for GCM (never reuse an IV with the
 * same key). The auth tag guarantees tamper-evidence: a corrupted/forged blob fails to
 * decrypt rather than silently returning garbage.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const CIPHER_VERSION = 'v1';

export function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [CIPHER_VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

export function decryptValue(payload: string, key: Buffer): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
    throw new Error('Unrecognized or unsupported ciphertext format for Integration secret.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** True if a config field value is already one of our encrypted blobs (idempotency guard —
 * re-encrypting an already-encrypted value would lock it behind a second layer forever). */
export function isEncryptedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${CIPHER_VERSION}:`);
}
