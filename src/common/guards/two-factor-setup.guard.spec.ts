import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext, RequestContextData } from '../../core/context/request-context';
import { AppException } from '../errors/app.exception';
import { TwoFactorSetupGuard } from './two-factor-setup.guard';

/** TZ §6.2 — "ADMIN uchun 2FA majburiy": admin without TOTP is locked to /me/* + 2FA setup. */
describe('TwoFactorSetupGuard', () => {
  const guard = new TwoFactorSetupGuard(new Reflector());

  function ctxWith(metadata: Record<string, unknown>): ExecutionContext {
    const handler = () => undefined;
    Object.entries(metadata).forEach(([key, value]) => Reflect.defineMetadata(key, value, handler));
    return {
      getHandler: () => handler,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  function runAs(user: RequestContextData['user'], ctx: ExecutionContext): boolean {
    let result = false;
    RequestContext.run(
      { requestId: 'r', traceId: 't', startedAt: Date.now(), user },
      () => {
        result = guard.canActivate(ctx);
      },
    );
    return result;
  }

  it('blocks an ADMIN without 2FA from a normal (non-exempt) route — 403 TWO_FACTOR_SETUP_REQUIRED', () => {
    const user = { id: 'usr_1', type: 'user' as const, role: 'ADMIN', twoFactorEnabled: false };
    expect(() => runAs(user, ctxWith({}))).toThrow(AppException);
    try {
      runAs(user, ctxWith({}));
    } catch (err) {
      expect((err as AppException).code).toBe('TWO_FACTOR_SETUP_REQUIRED');
    }
  });

  it('allows an ADMIN without 2FA to reach a @TwoFactorExempt() route (e.g. /me/profile, /auth/2fa/enroll)', () => {
    const user = { id: 'usr_1', type: 'user' as const, role: 'ADMIN', twoFactorEnabled: false };
    expect(runAs(user, ctxWith({ 'onebook:two-factor-exempt': true }))).toBe(true);
  });

  it('allows an ADMIN with 2FA enabled through any route', () => {
    const user = { id: 'usr_1', type: 'user' as const, role: 'ADMIN', twoFactorEnabled: true };
    expect(runAs(user, ctxWith({}))).toBe(true);
  });

  it('never blocks non-ADMIN roles regardless of twoFactorEnabled', () => {
    const user = { id: 'usr_2', type: 'user' as const, role: 'DISPATCHER', twoFactorEnabled: false };
    expect(runAs(user, ctxWith({}))).toBe(true);
  });

  it('never blocks a driver subject', () => {
    const user = { id: 'drv_1', type: 'driver' as const };
    expect(runAs(user, ctxWith({}))).toBe(true);
  });

  it(
    'Google-Sign-In-does-not-bypass-2FA invariant: an ADMIN account is gated identically ' +
      'regardless of which login method produced the token — the guard only ever inspects ' +
      "`user.role` / `user.twoFactorEnabled` from the RequestContext, never a login-method claim",
    () => {
      const adminFromPassword = { id: 'usr_1', type: 'user' as const, role: 'ADMIN', twoFactorEnabled: false };
      const adminFromGoogle = { id: 'usr_1', type: 'user' as const, role: 'ADMIN', twoFactorEnabled: false };
      expect(() => runAs(adminFromPassword, ctxWith({}))).toThrow(AppException);
      expect(() => runAs(adminFromGoogle, ctxWith({}))).toThrow(AppException);
    },
  );
});
