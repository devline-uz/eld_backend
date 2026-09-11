import { Injectable, Logger } from '@nestjs/common';

export type AuditSnapshotLoader = (id: string) => Promise<Record<string, unknown> | null>;

/**
 * TZ §18 / D-002 — lets `AuditInterceptor` fetch a "before" snapshot without knowing anything
 * about repositories: each feature module registers a loader for the `object` name it uses in
 * `@Audit({ object: ... })` (e.g. `RolesModule` registers `'Role'`). This keeps the interceptor
 * decoupled from feature modules (no import cycle) while still giving callers a real snapshot
 * mechanism instead of hand-assembling `before`/`after` at every call site.
 */
@Injectable()
export class AuditSnapshotRegistry {
  private readonly logger = new Logger(AuditSnapshotRegistry.name);
  private readonly loaders = new Map<string, AuditSnapshotLoader>();

  register(objectType: string, loader: AuditSnapshotLoader): void {
    this.loaders.set(objectType, loader);
  }

  async load(objectType: string, id: string | undefined): Promise<Record<string, unknown> | null> {
    if (!id) return null;
    const loader = this.loaders.get(objectType);
    if (!loader) return null;
    try {
      return await loader(id);
    } catch (err) {
      // Snapshotting must never break the request it describes (same rule as AuditService).
      this.logger.warn({ err, objectType, id }, 'Audit snapshot loader failed');
      return null;
    }
  }
}
