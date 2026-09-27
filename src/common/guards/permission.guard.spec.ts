import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ContextUser, RequestContext } from '../../core/context/request-context';
import { PermissionKey, PermissionLevel } from '../decorators/permission.types';
import { PERM_METADATA_KEY, PermRequirement } from '../decorators/perm.decorator';
import { DEFAULT_ROLE_MATRIX } from '../../modules/roles/permission-matrix';
import { AppException } from '../errors/app.exception';
import { PermissionGuard } from './permission.guard';

/**
 * TZ §6.4 — permission test for every seeded role (Global gates: "Permission test written
 * for every role"). Table-driven off `DEFAULT_ROLE_MATRIX` (the single source of truth
 * also used by `prisma/seed.ts`) rather than a hand-copied duplicate of the 22-key matrix,
 * so a future matrix edit automatically grows/shrinks this suite instead of silently
 * passing against stale expectations.
 */
describe('PermissionGuard — every role (TZ §6.4)', () => {
  const guard = new PermissionGuard(new Reflector());

  function ctxRequiring(req: PermRequirement): ExecutionContext {
    const handler = () => undefined;
    Reflect.defineMetadata(PERM_METADATA_KEY, req, handler);
    return { getHandler: () => handler, getClass: () => class {} } as unknown as ExecutionContext;
  }

  function runAs(user: ContextUser, req: PermRequirement): boolean {
    let result = false;
    RequestContext.run(
      { requestId: 'r', traceId: 't', startedAt: Date.now(), user },
      () => {
        result = guard.canActivate(ctxRequiring(req));
      },
    );
    return result;
  }

  const roles = Object.keys(DEFAULT_ROLE_MATRIX) as (keyof typeof DEFAULT_ROLE_MATRIX)[];

  describe.each(roles)('role = %s', (role) => {
    const matrix = DEFAULT_ROLE_MATRIX[role];
    const user: ContextUser = { id: `usr_${role}`, type: 'user', role, permissions: matrix };

    it.each(Object.entries(matrix) as [PermissionKey, PermissionLevel][])(
      '%s is %s',
      (key, level) => {
        if (level === 'FULL') {
          // FULL grants both a READ-level and a FULL-level requirement.
          expect(runAs(user, { key, level: 'READ' })).toBe(true);
          expect(runAs(user, { key, level: 'FULL' })).toBe(true);
        } else if (level === 'READ') {
          // READ allows reads but must reject a write (FULL) requirement.
          expect(runAs(user, { key, level: 'READ' })).toBe(true);
          expect(() => runAs(user, { key, level: 'FULL' })).toThrow(AppException);
        } else {
          // NONE rejects even the lowest (READ) requirement.
          expect(() => runAs(user, { key, level: 'READ' })).toThrow(AppException);
          expect(() => runAs(user, { key, level: 'FULL' })).toThrow(AppException);
        }
      },
    );
  });

  it('tz.md correction 1: reportsTransfer is NONE (not READ) for DISPATCHER', () => {
    expect(DEFAULT_ROLE_MATRIX.DISPATCHER.reportsTransfer).toBe('NONE');
    expect(() =>
      runAs(
        { id: 'usr_dispatcher', type: 'user', role: 'DISPATCHER', permissions: DEFAULT_ROLE_MATRIX.DISPATCHER },
        { key: 'reportsTransfer', level: 'READ' },
      ),
    ).toThrow(AppException);
  });

  it('tz.md correction 2: trips is FULL for DISPATCHER', () => {
    expect(
      runAs(
        { id: 'usr_dispatcher', type: 'user', role: 'DISPATCHER', permissions: DEFAULT_ROLE_MATRIX.DISPATCHER },
        { key: 'trips', level: 'FULL' },
      ),
    ).toBe(true);
  });

  it('403 body carries the key/required/granted detail for debugging', () => {
    const dispatcher: ContextUser = {
      id: 'usr_dispatcher',
      type: 'user',
      role: 'DISPATCHER',
      permissions: DEFAULT_ROLE_MATRIX.DISPATCHER,
    };
    try {
      runAs(dispatcher, { key: 'reportsTransfer', level: 'READ' });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).details).toEqual({
        key: 'reportsTransfer',
        required: 'READ',
        granted: 'NONE',
      });
    }
  });

  // -----------------------------------------------------------------------
  // Driver subject — TZ §6.1: a driver token must never reach back-office
  // permission-guarded endpoints. Drivers carry no `permissions` matrix at all, so
  // every key resolves to the guard's NONE default.
  // -----------------------------------------------------------------------
  describe('driver subject', () => {
    const driver: ContextUser = { id: 'drv_johnsmith', type: 'driver' };

    it.each(Object.keys(DEFAULT_ROLE_MATRIX.ADMIN) as PermissionKey[])(
      'rejects a driver token on the %s permission key (no permissions matrix on driver principals)',
      (key) => {
        expect(() => runAs(driver, { key, level: 'READ' })).toThrow(AppException);
      },
    );
  });

  // -----------------------------------------------------------------------
  // B-13 — `@PermAny` (array metadata): passes if the caller meets ANY requirement.
  // -----------------------------------------------------------------------
  describe('PermAny (array requirement — B-13)', () => {
    it('grants access when only the second requirement is met (dispatcher: vehicles:READ, trips:FULL)', () => {
      const dispatcher: ContextUser = { id: 'usr_dispatcher', type: 'user', role: 'DISPATCHER', permissions: DEFAULT_ROLE_MATRIX.DISPATCHER };
      expect(
        runAs(dispatcher, [
          { key: 'vehicles', level: 'FULL' },
          { key: 'trips', level: 'FULL' },
        ] as never),
      ).toBe(true);
    });

    it('rejects when none of the requirements are met', () => {
      const viewer: ContextUser = { id: 'usr_viewer', type: 'user', role: 'VIEWER', permissions: DEFAULT_ROLE_MATRIX.VIEWER };
      expect(() =>
        runAs(viewer, [
          { key: 'vehicles', level: 'FULL' },
          { key: 'trips', level: 'FULL' },
        ] as never),
      ).toThrow(AppException);
    });
  });

  it('unauthenticated (no RequestContext.user) is rejected with UNAUTHORIZED, not FORBIDDEN', () => {
    let threw: unknown;
    RequestContext.run({ requestId: 'r', traceId: 't', startedAt: Date.now() }, () => {
      try {
        guard.canActivate(ctxRequiring({ key: 'dashboard', level: 'READ' }));
      } catch (err) {
        threw = err;
      }
    });
    expect(threw).toBeInstanceOf(AppException);
    expect((threw as AppException).getStatus()).toBe(401);
  });
});
