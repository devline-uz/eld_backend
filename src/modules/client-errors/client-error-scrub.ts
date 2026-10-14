/**
 * D-158 — strips credentials and personal data from client error text before it leaves the API.
 * Pure functions; order matters (key/value pairs first so the value is gone before the JWT /
 * email patterns run, then Bearer headers, bare JWTs, emails).
 */
const REDACTED = '[REDACTED]';

/** `"refreshToken": "..."`, `password=...`, `access_token: ...` — JSON, query string or log text. */
const SECRET_KEY_VALUE =
  /(["']?\b(?:refresh_?token|access_?token|id_?token|password|passwd|pin|secret|authorization)\b["']?\s*[:=]\s*)((?:(?:Bearer|Basic)\s+)?(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,&;}\]]+))/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
/** A JWT (header.payload[.signature]) or any long `eyJ...` base64url run. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){0,2}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function scrubSecrets(text: string): string {
  return text
    .replace(SECRET_KEY_VALUE, (_m, key: string, value: string) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${key}${quote}${REDACTED}${quote}`;
    })
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(EMAIL, '[EMAIL]');
}

export function scrubOptional(text: string | undefined): string | undefined {
  return text === undefined ? undefined : scrubSecrets(text);
}
