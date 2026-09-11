import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { AuditInterceptor, AUDIT_EVENT, AuditEventPayload } from './audit.interceptor';
import { AuditSnapshotRegistry } from '../audit/audit-snapshot.registry';
import { EventBusService } from '../../core/events/event-bus.service';
import { RequestContext } from '../../core/context/request-context';
import { AuditOptions } from '../decorators/audit.decorator';

function makeContext(params: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function withRequestContext<T>(fn: () => T): T {
  return RequestContext.run(
    { requestId: 'req_1', traceId: 'trace_1', startedAt: Date.now(), user: { id: 'admin_1', type: 'user' } },
    fn,
  );
}

describe('AuditInterceptor (TZ §18 — before/after snapshotting)', () => {
  let reflector: Reflector;
  let events: EventBusService;
  let registry: AuditSnapshotRegistry;
  let interceptor: AuditInterceptor;
  let published: AuditEventPayload[];

  beforeEach(() => {
    reflector = new Reflector();
    events = new EventBusService();
    registry = new AuditSnapshotRegistry();
    interceptor = new AuditInterceptor(reflector, events, registry);
    published = [];
    events.on<AuditEventPayload>(AUDIT_EVENT, (event) => {
      published.push(event.payload);
      return Promise.resolve();
    });
  });

  function withMetadata(options: AuditOptions): void {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(options);
  }

  const next = (result: unknown): CallHandler => ({ handle: () => of(result) });

  it('passes the response through unchanged when no @Audit metadata is present', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const result = await firstValueFrom(interceptor.intercept(makeContext({}), next({ ok: true })));
    expect(result).toEqual({ ok: true });
    expect(published).toHaveLength(0);
  });

  it('CREATE: before is null, after is the created entity, diffed via the registry when possible', async () => {
    withMetadata({ object: 'Role', action: 'CREATE' });
    registry.register('Role', async (id) => ({ id, name: 'Dispatcher', permissions: {} }));

    const result = await withRequestContext(() =>
      firstValueFrom(interceptor.intercept(makeContext({}), next({ id: 'role_1', name: 'Dispatcher' }))),
    );

    expect(result).toEqual({ id: 'role_1', name: 'Dispatcher' }); // original result untouched
    await flushMicrotasks();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ action: 'CREATE', objectType: 'Role', objectId: 'role_1', actorId: 'admin_1' });
    expect(published[0].before).toBeNull();
    expect(published[0].after).toEqual({ id: 'role_1', name: 'Dispatcher', permissions: {} });
  });

  it('UPDATE: diffs the pre-handler snapshot against the post-handler snapshot', async () => {
    withMetadata({ object: 'Role', action: 'UPDATE' });
    let call = 0;
    registry.register('Role', async (id) => {
      call += 1;
      return call === 1 ? { id, name: 'Old' } : { id, name: 'New' };
    });

    await withRequestContext(() =>
      firstValueFrom(interceptor.intercept(makeContext({ id: 'role_1' }), next({ id: 'role_1', name: 'New' }))),
    );
    await flushMicrotasks();

    expect(published[0].before).toEqual({ name: 'Old' });
    expect(published[0].after).toEqual({ name: 'New' });
    expect(published[0].objectId).toBe('role_1');
  });

  it('DELETE: after is forced to null even if a loader would still find the row', async () => {
    withMetadata({ object: 'Role', action: 'DELETE' });
    registry.register('Role', async (id) => ({ id, name: 'Still here' }));

    await withRequestContext(() =>
      firstValueFrom(interceptor.intercept(makeContext({ id: 'role_1' }), next({ success: true }))),
    );
    await flushMicrotasks();

    // Nothing to diff against (after = null), so the full pre-delete row is kept.
    expect(published[0].before).toEqual({ id: 'role_1', name: 'Still here' });
    expect(published[0].after).toBeNull();
  });

  it('never leaks a secret field into the published payload', async () => {
    withMetadata({ object: 'User', action: 'UPDATE' });
    let call = 0;
    registry.register('User', async (id) => {
      call += 1;
      return call === 1
        ? { id, email: 'a@b.com', passwordHash: 'old-hash' }
        : { id, email: 'a@b.com', passwordHash: 'new-hash' };
    });

    await withRequestContext(() =>
      firstValueFrom(interceptor.intercept(makeContext({ id: 'usr_1' }), next({ id: 'usr_1' }))),
    );
    await flushMicrotasks();

    expect(published[0].before).toEqual({ passwordHash: '[REDACTED]' });
    expect(published[0].after).toEqual({ passwordHash: '[REDACTED]' });
  });
});

/** Lets the interceptor's internal `switchMap`/promise chain settle before assertions. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
