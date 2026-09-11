import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { ENVELOPE_FORMAT, FmcsaEncryptionService } from './fmcsa-encryption.service';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function service(value?: string): FmcsaEncryptionService {
  return new FmcsaEncryptionService({ get: () => value } as never);
}

/** Mirror of the envelope documented in fmcsa-encryption.service.ts. */
function decrypt(body: Buffer): string {
  const [format, wrappedKey, iv, tag, ciphertext] = body.toString('utf8').trim().split('\n');
  expect(format).toBe(ENVELOPE_FORMAT);
  const contentKey = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(wrappedKey, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

describe('FmcsaEncryptionService (tz.md §10.4)', () => {
  it('reports not configured when FMCSA_PUBLIC_KEY is unset (the current TEST-mode reality)', () => {
    expect(service(undefined).configured).toBe(false);
  });

  it('reports not configured when FMCSA_PUBLIC_KEY is garbage', () => {
    expect(service('not-a-key').configured).toBe(false);
  });

  it('refuses to encrypt without a key rather than emailing plaintext RODS', () => {
    expect(() => service(undefined).encrypt(Buffer.from('SMITH38018'))).toThrow(AppException);
    try {
      service(undefined).encrypt(Buffer.from('x'));
    } catch (err) {
      expect((err as AppException).code).toBe('TRANSFER_ENCRYPTION_UNAVAILABLE');
    }
  });

  it('accepts a PEM public key and round-trips the output file', () => {
    const svc = service(publicPem);
    expect(svc.configured).toBe(true);
    const csv = 'ELD File Header Segment:\r\nSmith,John,jsmith,CT,W8569238,4F\r\n';
    const payload = svc.encrypt(Buffer.from(csv, 'utf8'));
    expect(payload.format).toBe(ENVELOPE_FORMAT);
    expect(payload.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.body.toString('utf8')).not.toContain('Smith');
    expect(decrypt(payload.body)).toBe(csv);
  });

  it('accepts a base64-encoded PEM (how the secret is stored in the env file)', () => {
    const svc = service(Buffer.from(publicPem, 'utf8').toString('base64'));
    expect(svc.configured).toBe(true);
    expect(decrypt(svc.encrypt(Buffer.from('abc')).body)).toBe('abc');
  });

  it('uses a fresh content key per file (two encryptions never produce the same bytes)', () => {
    const svc = service(publicPem);
    const a = svc.encrypt(Buffer.from('same'));
    const b = svc.encrypt(Buffer.from('same'));
    expect(a.body.equals(b.body)).toBe(false);
    expect(a.keyFingerprint).toBe(b.keyFingerprint);
  });
});
