import { AppConfigService } from '../../../core/config/config.service';
import { encryptConfigSecrets, redactConfigSecrets, decryptConfigSecret, isSecretConfigKey } from './config-secrets';
import { IntegrationCipherService } from './integration-cipher.service';

function makeCipher(): IntegrationCipherService {
  const config = { get: () => 'ZGV2LW9ubHktMzItYnl0ZS1rZXktY2hhbmdlLW1lISE=' } as unknown as AppConfigService;
  return new IntegrationCipherService(config);
}

describe('config-secrets', () => {
  const cipher = makeCipher();

  it('isSecretConfigKey matches known credential field names, not plain fields', () => {
    expect(isSecretConfigKey('apiKey')).toBe(true);
    expect(isSecretConfigKey('api_key')).toBe(true);
    expect(isSecretConfigKey('clientSecret')).toBe(true);
    expect(isSecretConfigKey('accessToken')).toBe(true);
    expect(isSecretConfigKey('signingSecret')).toBe(true);
    expect(isSecretConfigKey('password')).toBe(true);
    expect(isSecretConfigKey('url')).toBe(false);
    expect(isSecretConfigKey('enabled')).toBe(false);
    expect(isSecretConfigKey('syncFrequencyMin')).toBe(false);
  });

  it('encryptConfigSecrets encrypts only secret-looking fields, leaves the rest untouched', () => {
    const out = encryptConfigSecrets({ url: 'https://example.com', apiKey: 'sk_live_123', enabled: true }, cipher);
    expect(out.url).toBe('https://example.com');
    expect(out.enabled).toBe(true);
    expect(out.apiKey).not.toBe('sk_live_123');
    expect(String(out.apiKey)).toMatch(/^v1:/);
  });

  it('is idempotent — re-encrypting an already-encrypted value does not double-wrap it', () => {
    const once = encryptConfigSecrets({ apiKey: 'sk_live_123' }, cipher);
    const twice = encryptConfigSecrets(once, cipher);
    expect(twice.apiKey).toBe(once.apiKey);
  });

  it('redactConfigSecrets never returns plaintext or ciphertext for a secret field', () => {
    const encrypted = encryptConfigSecrets({ url: 'https://example.com', apiKey: 'sk_live_123' }, cipher);
    const redacted = redactConfigSecrets(encrypted);
    expect(redacted.url).toBe('https://example.com');
    expect(redacted.apiKey).toBe('[REDACTED]');
  });

  it('redactConfigSecrets tolerates null/non-object config', () => {
    expect(redactConfigSecrets(null)).toEqual({});
    expect(redactConfigSecrets(undefined)).toEqual({});
    expect(redactConfigSecrets('oops')).toEqual({});
  });

  it('decryptConfigSecret recovers the original plaintext for internal use', () => {
    const encrypted = encryptConfigSecrets({ secret: 'whsec_abc' }, cipher);
    expect(decryptConfigSecret(encrypted, 'secret', cipher)).toBe('whsec_abc');
  });

  it('decryptConfigSecret returns undefined for a missing field', () => {
    expect(decryptConfigSecret({}, 'secret', cipher)).toBeUndefined();
  });
});
