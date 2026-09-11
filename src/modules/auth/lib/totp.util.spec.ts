import { authenticator } from 'otplib';
import { generateRecoveryCodes, generateTotpSecret, totpKeyUri, verifyTotp } from './totp.util';

describe('totp.util (TZ §6.5 — RFC 6238, 8 recovery codes)', () => {
  it('generates a secret and accepts the code it produces', () => {
    const secret = generateTotpSecret();
    const code = authenticator.generate(secret);
    expect(verifyTotp(code, secret)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp('000000', secret)).toBe(false);
  });

  it('rejects a code generated against a different secret', () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const codeForB = authenticator.generate(secretB);
    expect(verifyTotp(codeForB, secretA)).toBe(false);
  });

  it('never throws on garbage input', () => {
    expect(verifyTotp('not-a-code', 'not-a-secret')).toBe(false);
  });

  it('builds an otpauth:// key URI carrying the account email', () => {
    const uri = totpKeyUri('sarah.chen@universal-logistics.example', 'ABCDEFGHIJKLMNOP');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('OneBook');
  });

  it('generates exactly 8 unique recovery codes in XXXXX-XXXXX form', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  });
});
