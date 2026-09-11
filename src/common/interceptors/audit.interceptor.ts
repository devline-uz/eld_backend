import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, Observable, of, switchMap } from 'rxjs';
import { EventBusService } from '../../core/events/event-bus.service';
import { RequestContext } from '../../core/context/request-context';
import { AUDIT_METADATA_KEY, AuditOptions } from '../decorators/audit.decorator';
import { AuditSnapshotRegistry } from '../audit/audit-snapshot.registry';
import { diffSnapshots } from '../audit/redact';

/** Domain event name consumed by modules/audit (Phase 1, eld-auth-rbac owns the writer). */
export const AUDIT_EVENT = 'audit.record';

export interface AuditEventPayload {
  actorId?: string;
  actorType?: 'user' | 'driver' | 'api-key';
  action: string;
  objectType: string;
  objectId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string;
  userAgent?: string;
  traceId?: string;
}

/**
 * TZ §18 — turns `@Audit(...)` into an audit record. Emits a domain event on success; the
 * AuditRepository that persists it (append-only, DB-level REVOKE) is owned by the audit module.
 *
 * `before`/`after`: this interceptor fetches a "before" snapshot from the
 * `AuditSnapshotRegistry` *before* invoking the handler (using the route's id param), then an
 * "after" snapshot once the handler has run (DELETE forces `after = null` since the row is
 * gone). The two are reduced to a field-level diff (`diffSnapshots`, D-002) and redacted
 * (`redactSecrets`) before ever leaving this file — no call site hand-assembles snapshots.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly events: EventBusService,
    private readonly snapshots: AuditSnapshotRegistry,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<AuditOptions | undefined>(
      AUDIT_METADATA_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!options) return next.handle();

    const req = ctx.switchToHttp().getRequest<Request>();
    const idParam = options.idParam ?? 'id';
    const routeId = paramValue(req.params[idParam]);

    return from(this.snapshots.load(options.object, routeId)).pipe(
      switchMap((before) =>
        next.handle().pipe(
          switchMap((result) => {
            const objectId = routeId ?? resultId(result, options.object) ?? '';
            const afterPromise =
              options.action === 'DELETE' ? Promise.resolve(null) : this.resolveAfter(options.object, objectId, result);
            return from(afterPromise).pipe(
              switchMap((after) => {
                this.publish(options, objectId, before, after);
                return of(result);
              }),
            );
          }),
        ),
      ),
    );
  }

  private async resolveAfter(
    objectType: string,
    objectId: string,
    result: unknown,
  ): Promise<Record<string, unknown> | null> {
    const fromRegistry = await this.snapshots.load(objectType, objectId);
    if (fromRegistry) return fromRegistry;
    return extractEntity(result, objectType);
  }

  private publish(
    options: AuditOptions,
    objectId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): void {
    const rc = RequestContext.get();
    const { before: beforeDiff, after: afterDiff } = diffSnapshots(before, after);
    const payload: AuditEventPayload = {
      actorId: rc?.user?.id,
      actorType: rc?.user?.type,
      action: options.action,
      objectType: options.object,
      objectId,
      before: beforeDiff,
      after: afterDiff,
      ip: rc?.ip,
      userAgent: rc?.userAgent,
      traceId: rc?.traceId,
    };
    void this.events.publish(AUDIT_EVENT, payload);
  }
}

function paramValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Finds the entity inside a handler's result, either at the top level or nested under a
 * camelCase key matching the audited object (e.g. `{ user: {...}, inviteToken }` for `'User'`,
 * `{ apiKey: {...}, plaintextKey }` for `'ApiKey'`). */
function extractEntity(result: unknown, objectType: string): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if ('id' in record) return record;
  const nestedKey = objectType.charAt(0).toLowerCase() + objectType.slice(1);
  const nested = record[nestedKey];
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return null;
}

function resultId(result: unknown, objectType: string): string | undefined {
  const entity = extractEntity(result, objectType);
  const id = entity?.id;
  if (typeof id === 'string' || typeof id === 'number') return String(id);
  return undefined;
}
