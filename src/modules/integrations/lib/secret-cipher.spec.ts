import { decryptValue, encryptValue, isEncryptedValue } from './secret-cipher';

const KEY = Buffer.from('ZGV2LW9ubHktMzItYnl0ZS1rZXktY2hhbmdlLW1lISE=', 'base64');
const OTHER_KEY = Buffer.alloc(32, 7);

describe('secret-cipher (AES-256-GCM)', () => {
  it('round-trips a plaintext value', () => {
    const payload = encryptValue('super-secret-api-key', KEY);
    expect(decryptValue(payload, KEY)).toBe('super-secret-api-key');
  });

  it('never stores the plaintext inside the ciphertext payload', () => {
    const payload = encryptValue('super-secret-api-key', KEY);
    expect(payload).not.toContain('super-secret-api-key');
  });

  it('produces a different ciphertext each call (random IV, no IV reuse)', () => {
    const a = encryptValue('same-value', KEY);
    const b = encryptValue('same-value', KEY);
    expect(a).not.toBe(b);
  });

  it('is authenticated — a tampered blob fails to decrypt rather than returning garbage', () => {
    const payload = encryptValue('super-secret-api-key', KEY);
    const parts = payload.split(':');
    const tamperedData = Buffer.from(parts[3], 'base64');
    tamperedData[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], tamperedData.toString('base64')].join(':');
    expect(() => decryptValue(tampered, KEY)).toThrow();
  });

  it('fails closed with the wrong key', () => {
    const payload = encryptValue('super-secret-api-key', KEY);
    expect(() => decryptValue(payload, OTHER_KEY)).toThrow();
  });

  it('rejects a payload in an unrecognized format', () => {
    expect(() => decryptValue('not-our-format', KEY)).toThrow();
    expect(() => decryptValue('v2:a:b:c', KEY)).toThrow();
  });

  it('isEncryptedValue recognizes our v1 blobs and rejects plaintext', () => {
    const payload = encryptValue('x', KEY);
    expect(isEncryptedValue(payload)).toBe(true);
    expect(isEncryptedValue('plain-api-key')).toBe(false);
    expect(isEncryptedValue(123)).toBe(false);
  });
});
