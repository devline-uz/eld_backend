import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TZ §16 — `X-OneBook-Signature: t=<ts>,v1=<hmac_sha256(secret, "t.body")>`. The signed
 * message is the literal string `${timestamp}.${rawBody}` (Stripe-style), so a consumer can
 * reject stale/forged deliveries by checking both the HMAC and the `t` freshness window.
 */
export function computeWebhookSignature(secret: string, timestampSec: number, rawBody: string): string {
  const hmac = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${hmac}`;
}

export function buildSignatureHeader(secret: string, rawBody: string, now: Date = new Date()): string {
  return computeWebhookSignature(secret, Math.floor(now.getTime() / 1000), rawBody);
}

/** Verifies a received `X-OneBook-Signature` header (useful for our own webhook e2e tests and
 * for any inbound endpoint that later needs to check a peer's signature of the same shape). */
export function verifyWebhookSignature(header: string, secret: string, rawBody: string): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
  if (!match) return false;
  const [, ts, sig] = match;
  const expected = computeWebhookSignature(secret, Number(ts), rawBody);
  const expectedSig = expected.split('v1=')[1];
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
