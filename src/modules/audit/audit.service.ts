import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EditorType, Prisma } from '@prisma/client';
import { EventBusService } from '../../core/events/event-bus.service';
import { AUDIT_EVENT, AuditEventPayload } from '../../common/interceptors/audit.interceptor';
import { AuditLogFilter, AuditRepository } from './audit.repository';

export interface AuditLogView {
  id: string;
  actorId: string;
  actorType: EditorType;
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

// API-key callers have no DRIVER/USER row and map to SYSTEM (TZ §18); `actorId` still
// carries the ApiKey.id so the audit row stays traceable to which key acted.
const ACTOR_TYPE_MAP: Record<'user' | 'driver' | 'api-key', EditorType> = {
  user: EditorType.USER,
  driver: EditorType.DRIVER,
  'api-key': EditorType.SYSTEM,
};

/**
 * TZ §18 — subscribes to the `audit.record` domain event published by `AuditInterceptor`
 * and INSERTs the row. Never subscribes with an `update`/`delete` path: the DB-level
 * `REVOKE` (TZ §18) is a second, independent enforcement layer, not the only one.
 */
@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly events: EventBusService,
    private readonly repo: AuditRepository,
  ) {}

  onModuleInit(): void {
    this.events.on<AuditEventPayload>(AUDIT_EVENT, async (event) => {
      const { payload } = event;
      try {
        await this.repo.insert({
          actorId: payload.actorId ?? 'system',
          actorType: payload.actorType ? ACTOR_TYPE_MAP[payload.actorType] : EditorType.SYSTEM,
          action: payload.action,
          objectType: payload.objectType,
          objectId: payload.objectId || 'unknown',
          // `diffSnapshots` (common/audit/redact.ts) has already stripped secrets and reduced
          // this to plain JSON-shaped data by the time it reaches here.
          before: (payload.before ?? undefined) as Prisma.InputJsonValue | undefined,
          after: (payload.after ?? undefined) as Prisma.InputJsonValue | undefined,
          ip: payload.ip,
          userAgent: payload.userAgent,
          detail: payload.traceId ? `traceId=${payload.traceId}` : undefined,
        });
      } catch (err) {
        // TZ §18 — audit must never break the request it describes; the interceptor already
        // returned the response by the time this handler runs (fire-and-forget publish).
        this.logger.error({ err, action: payload.action, objectType: payload.objectType }, 'Failed to persist audit log');
      }
    });
  }

  async list(filter: AuditLogFilter, limit: number, cursor?: string): Promise<{ items: AuditLogView[]; nextCursor: string | null }> {
    const { items, nextCursor } = await this.repo.list(filter, limit, cursor);
    return { items: items.map((i) => ({ ...i, id: String(i.id) })), nextCursor };
  }
}
