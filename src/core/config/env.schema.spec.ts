import { DEV_INTEGRATION_ENCRYPTION_KEY, DEV_JWT_SECRET, parseEnv } from './env.schema';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://localhost:6379' };

describe('env schema — DRIVER_EMAIL_CHANGE_HOLD_HOURS', () => {
  it('defaults to 48 hours', () => {
    expect(parseEnv(base).DRIVER_EMAIL_CHANGE_HOLD_HOURS).toBe(48);
  });

  it.each(['1', '24', '720'])('accepts %s', (value) => {
    expect(parseEnv({ ...base, DRIVER_EMAIL_CHANGE_HOLD_HOURS: value }).DRIVER_EMAIL_CHANGE_HOLD_HOURS).toBe(Number(value));
  });

  it('rejects 0 at startup with a clear message — the hold cannot be disabled', () => {
    expect(() => parseEnv({ ...base, DRIVER_EMAIL_CHANGE_HOLD_HOURS: '0' })).toThrow(
      /DRIVER_EMAIL_CHANGE_HOLD_HOURS: must be at least 1 hour.*cannot be disabled/,
    );
  });

  it.each(['-1', '0.5', '721', 'abc'])('rejects %s', (value) => {
    expect(() => parseEnv({ ...base, DRIVER_EMAIL_CHANGE_HOLD_HOURS: value })).toThrow(/DRIVER_EMAIL_CHANGE_HOLD_HOURS/);
  });
});

// Generated for the test only — random-looking, 32+ chars / 32 bytes, not used anywhere real.
const STRONG_JWT = 'q7Vt2LmX9pR4sK8wZ1cN6bH3yJ5fD0gA-uE+oI/TrWv';
const STRONG_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 73 + 11) % 256)).toString('base64');
const prod = { ...base, NODE_ENV: 'production', JWT_SECRET: STRONG_JWT, INTEGRATION_ENCRYPTION_KEY: STRONG_KEY };

describe('env schema — production secrets (CODE-001)', () => {
  it('accepts strong, non-default secrets in production', () => {
    const env = parseEnv(prod);
    expect(env.JWT_SECRET).toBe(STRONG_JWT);
    expect(env.INTEGRATION_ENCRYPTION_KEY).toBe(STRONG_KEY);
  });

  it('keeps the dev defaults working outside production (development and test)', () => {
    expect(parseEnv(base).JWT_SECRET).toBe(DEV_JWT_SECRET);
    expect(parseEnv({ ...base, NODE_ENV: 'test' }).INTEGRATION_ENCRYPTION_KEY).toBe(DEV_INTEGRATION_ENCRYPTION_KEY);
    expect(() => parseEnv({ ...base, NODE_ENV: 'development', JWT_SECRET: 'CHANGE_ME_32_CHARS_MINIMUM_XXXXXXXX' })).not.toThrow();
  });

  it('refuses a missing JWT_SECRET in production (the public default would apply)', () => {
    const { JWT_SECRET: _omit, ...env } = prod;
    expect(() => parseEnv(env)).toThrow(/JWT_SECRET: is unset or equals the built-in dev default.*NODE_ENV=production/);
  });

  it('refuses the built-in JWT default when set explicitly in production', () => {
    expect(() => parseEnv({ ...prod, JWT_SECRET: DEV_JWT_SECRET })).toThrow(/JWT_SECRET: is unset or equals the built-in dev default/);
  });

  it.each([
    'CHANGE_ME_32_CHARS_MINIMUM_XXXXXXXX', // .env.production.example / .env.development.example
    'please-change-me-this-is-a-long-string',
    'placeholder-value-0123456789-abcdefghij',
    'my-example-jwt-secret-0123456789-abcdef',
  ])('refuses placeholder JWT_SECRET %s in production', (value) => {
    expect(() => parseEnv({ ...prod, JWT_SECRET: value })).toThrow(/JWT_SECRET: looks like a template placeholder/);
  });

  it('refuses a low-entropy JWT_SECRET in production', () => {
    expect(() => parseEnv({ ...prod, JWT_SECRET: 'ab'.repeat(20) })).toThrow(/JWT_SECRET: has too few distinct characters/);
  });

  it('still refuses a JWT_SECRET shorter than 32 characters everywhere', () => {
    expect(() => parseEnv({ ...prod, JWT_SECRET: 'q7Vt2LmX9pR4sK8w' })).toThrow(/JWT_SECRET/);
    expect(() => parseEnv({ ...base, JWT_SECRET: 'q7Vt2LmX9pR4sK8w' })).toThrow(/JWT_SECRET/);
  });

  it('refuses a missing or default INTEGRATION_ENCRYPTION_KEY in production', () => {
    const { INTEGRATION_ENCRYPTION_KEY: _omit, ...env } = prod;
    expect(() => parseEnv(env)).toThrow(/INTEGRATION_ENCRYPTION_KEY: is unset or equals the built-in dev default/);
    expect(() => parseEnv({ ...prod, INTEGRATION_ENCRYPTION_KEY: DEV_INTEGRATION_ENCRYPTION_KEY })).toThrow(
      /INTEGRATION_ENCRYPTION_KEY: is unset or equals the built-in dev default/,
    );
  });

  it('refuses a placeholder INTEGRATION_ENCRYPTION_KEY (raw or base64 of one) in production', () => {
    expect(() => parseEnv({ ...prod, INTEGRATION_ENCRYPTION_KEY: 'CHANGE_ME' })).toThrow(/INTEGRATION_ENCRYPTION_KEY: looks like a template placeholder/);
    const encoded = Buffer.from('prod-32-byte-key-change-me-now!!').toString('base64');
    expect(() => parseEnv({ ...prod, INTEGRATION_ENCRYPTION_KEY: encoded })).toThrow(/INTEGRATION_ENCRYPTION_KEY: looks like a template placeholder/);
  });

  it.each([
    ['16 bytes', Buffer.alloc(16, 7).toString('base64')],
    ['not base64', 'this is not base64 at all!!'],
  ])('refuses an INTEGRATION_ENCRYPTION_KEY that is %s in production', (_label, value) => {
    expect(() => parseEnv({ ...prod, INTEGRATION_ENCRYPTION_KEY: value })).toThrow(/INTEGRATION_ENCRYPTION_KEY: must be standard base64 of exactly 32 bytes/);
  });

  it('refuses an all-zero 32-byte key in production', () => {
    expect(() => parseEnv({ ...prod, INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') })).toThrow(
      /INTEGRATION_ENCRYPTION_KEY: has too few distinct bytes/,
    );
  });

  it('reports both problems at once and never echoes the secret value', () => {
    let message = '';
    try {
      parseEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'CHANGE_ME_32_CHARS_MINIMUM_XXXXXXXX' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).toMatch(/INTEGRATION_ENCRYPTION_KEY/);
    expect(message).not.toContain('CHANGE_ME_32_CHARS_MINIMUM_XXXXXXXX');
    expect(message).not.toContain(DEV_INTEGRATION_ENCRYPTION_KEY);
  });
});

describe('env schema — TRUST_PROXY (CODE-004)', () => {
  it('defaults to loopback (Caddy on the same host)', () => {
    expect(parseEnv(base).TRUST_PROXY).toEqual(['loopback']);
  });

  it('parses a comma-separated list of ranges, IPs and CIDRs', () => {
    expect(parseEnv({ ...base, TRUST_PROXY: 'loopback, 172.16.0.0/12 ,10.0.0.5,fd00::/8,uniquelocal' }).TRUST_PROXY).toEqual([
      'loopback',
      '172.16.0.0/12',
      '10.0.0.5',
      'fd00::/8',
      'uniquelocal',
    ]);
  });

  it.each(['false', 'none', ''])('%p disables proxy trust', (value) => {
    expect(parseEnv({ ...base, TRUST_PROXY: value }).TRUST_PROXY).toBe(false);
  });

  it.each(['true', '1', '2'])('refuses %p — it would let a direct client spoof X-Forwarded-For', (value) => {
    expect(() => parseEnv({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY: .*spoof X-Forwarded-For/);
  });

  it.each(['localhost', '300.1.1.1', '10.0.0.0/33', '10.0.0.0/8/1', 'loopback,caddy'])('refuses invalid entry %p', (value) => {
    expect(() => parseEnv({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY: invalid entr/);
  });
});
