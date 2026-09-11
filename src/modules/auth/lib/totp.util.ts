import { randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';

/** RFC 6238 TOTP (30s step, 6 digits, SHA-1 — Google Authenticator / Authy compatible). */
export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpKeyUri(email: string, secret: string, issuer = 'OneBook ELD'): string {
  return authenticator.keyuri(email, issuer, secret);
}

export function verifyTotp(token: string, secret: string): boolean {
  try {
    return authenticator.check(token, secret);
  } catch {
    return false;
  }
}

/** TZ §6.5 — 8 recovery codes, shown once at enrolment. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => formatRecoveryCode());
}

function formatRecoveryCode(): string {
  // 10 random alphanumeric chars, grouped for readability: XXXXX-XXXXX
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  const bytes = randomBytes(10);
  let raw = '';
  for (let i = 0; i < 10; i++) {
    raw += alphabet[bytes[i] % alphabet.length];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Random opaque refresh-token / reset-token material (TZ §6.5 — hashed at rest). */
export function randomOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}
