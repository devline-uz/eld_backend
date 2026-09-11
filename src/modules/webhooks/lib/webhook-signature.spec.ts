import { buildSignatureHeader, computeWebhookSignature, verifyWebhookSignature } from './webhook-signature';

describe('webhook-signature', () => {
  it('matches the TZ §16 header shape: t=<ts>,v1=<hmac>', () => {
    const header = computeWebhookSignature('secret', 1789000000, '{"a":1}');
    expect(header).toMatch(/^t=1789000000,v1=[0-9a-f]{64}$/);
  });

  it('is deterministic for the same secret/timestamp/body', () => {
    const a = computeWebhookSignature('secret', 1000, 'body');
    const b = computeWebhookSignature('secret', 1000, 'body');
    expect(a).toBe(b);
  });

  it('changes if the body, secret, or timestamp changes', () => {
    const base = computeWebhookSignature('secret', 1000, 'body');
    expect(computeWebhookSignature('other-secret', 1000, 'body')).not.toBe(base);
    expect(computeWebhookSignature('secret', 1001, 'body')).not.toBe(base);
    expect(computeWebhookSignature('secret', 1000, 'other-body')).not.toBe(base);
  });

  it('buildSignatureHeader derives the timestamp from the given Date', () => {
    const header = buildSignatureHeader('secret', 'body', new Date(1789000000 * 1000));
    expect(header.startsWith('t=1789000000,')).toBe(true);
  });

  it('verifyWebhookSignature accepts a correctly signed header and rejects a tampered one', () => {
    const header = buildSignatureHeader('secret', 'body', new Date(1789000000 * 1000));
    expect(verifyWebhookSignature(header, 'secret', 'body')).toBe(true);
    expect(verifyWebhookSignature(header, 'wrong-secret', 'body')).toBe(false);
    expect(verifyWebhookSignature(header, 'secret', 'tampered-body')).toBe(false);
    expect(verifyWebhookSignature('garbage', 'secret', 'body')).toBe(false);
  });
});
