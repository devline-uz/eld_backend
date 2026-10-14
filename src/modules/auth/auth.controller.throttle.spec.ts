import 'reflect-metadata';
import { AuthController } from './auth.controller';
import { UserEmailController } from '../users/user-email.controller';

const LIMIT_KEY = 'THROTTLER:LIMITdefault';
const TTL_KEY = 'THROTTLER:TTLdefault';

/** TZ §6.5 — "login 5/daq/IP". Asserts the `@Throttle()` metadata on every login-family route. */
describe('AuthController — login rate limiting (TZ §6.5)', () => {
  it.each(['login', 'loginDriver', 'google', 'forgotDriverPassword', 'requestPasswordResetCode'])('%s is limited to 5 requests / 60s', (method) => {
    const handler = (AuthController.prototype as unknown as Record<string, () => void>)[method];
    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(5);
    expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(60_000);
  });

  it('refresh is limited to 30 requests / 60s (MB-20)', () => {
    const handler = AuthController.prototype.refresh;
    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(30);
    expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(60_000);
  });

  it('web reset-code confirm is limited to 10 requests / 60s', () => {
    const handler = AuthController.prototype.confirmPasswordResetCode;
    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(10);
    expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(60_000);
  });

  it.each(['verify', 'cancel'] as const)('B-84 email-change %s link is limited to 10 requests / 60s', (method) => {
    const handler = UserEmailController.prototype[method];
    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(10);
    expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(60_000);
  });

  it('logout is not rate-limited beyond the global 600/min default (no @Throttle override)', () => {
    const handler = AuthController.prototype.logout;
    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBeUndefined();
  });
});
