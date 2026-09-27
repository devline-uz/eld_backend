import { IntegrationCipherService } from './integration-cipher.service';
import { isEncryptedValue } from './secret-cipher';

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** Field-name heuristic for "this value is a secret" inside `Integration.config` (a free-form
 * JSON blob whose shape differs per provider — McLeod, WEX/Comdata, QuickBooks, Slack, the
 * generic outbound `webhook` provider). Every provider's credential fields (API key, OAuth
 * client secret, access/refresh token, signing secret, password) match one of these. */
// `webhookUrl` — a Slack incoming-webhook URL is itself the credential (anyone holding it can post
// to the channel), so it is encrypted and redacted like a key. The generic webhook's `url` is not.
const SECRET_KEY_PATTERN = /secret|token|password|api[_-]?key|signing|private[_-]?key|access[_-]?key|webhook[_-]?url/i;

export function isSecretConfigKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** Encrypts every secret-looking string field in `config`, leaving non-secret fields (URLs,
 * flags, sync frequency, etc.) readable in the DB row. Never double-encrypts a value that is
 * already one of our ciphertext blobs (idempotent on repeated upsert of an unchanged secret). */
export function encryptConfigSecrets(
  config: Record<string, unknown>,
  cipher: IntegrationCipherService,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (isSecretConfigKey(key) && typeof value === 'string' && value.length > 0 && !isEncryptedValue(value)) {
      out[key] = cipher.encrypt(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Returns `config` with every secret field replaced by a redaction placeholder — never the
 * ciphertext, never the plaintext. This is the ONLY shape `Integration.config` is allowed to
 * leave the process in: API responses and audit-log snapshots alike. */
export function redactConfigSecrets(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    out[key] = isSecretConfigKey(key) && typeof value === 'string' && value.length > 0 ? REDACTED_PLACEHOLDER : value;
  }
  return out;
}

/** Decrypts a single named secret out of a stored config, for internal use only (e.g. the
 * webhook processor signing an outbound delivery). Never exposed through a controller. */
export function decryptConfigSecret(
  config: unknown,
  key: string,
  cipher: IntegrationCipherService,
): string | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const value = (config as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return isEncryptedValue(value) ? cipher.decrypt(value) : value;
}
