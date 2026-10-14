import { parseEnv } from './env.schema';

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
