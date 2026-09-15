import 'reflect-metadata';
import { AuthController } from './auth.controller';

const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TTL_KEY = 'THROTTLER:TTLdefault';

/** TZ §6.5 — "login 5/daq/IP". Asserts the `@Throttle()` metadata on every login-family route. */
describe('AuthController — login rate limiting (TZ §6.5)', () => {
  it.each(['login', 'loginDriver', 'google'])('%s is limited to 5 requests / 60s', (method) => {
    const handler = (AuthController.prototype as unknown as Record<string, () => void>)[method];
    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(5);
    expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(60_000);
  });

  it('logout is not rate-limited beyond the global 600/min default (no @Throttle override)', () => {
    const handler = AuthController.prototype.logout;
    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBeUndefined();
  });
});
