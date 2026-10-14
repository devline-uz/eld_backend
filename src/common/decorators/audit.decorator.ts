import { SetMetadata } from '@nestjs/common';

export const AUDIT_METADATA_KEY = 'onebook:audit';

export interface AuditOptions {
  /** Entity name, e.g. 'Driver'. */
  object: string;
  /** Verb recorded in AuditLog.action, e.g. 'UPDATE'. */
  action: string;
  /** Route param that holds the object id; defaults to 'id'. */
  idParam?: string;
  /** Top-level field of the handler's result that holds the new object's id when there is no
   * route id and the result is not the entity itself (e.g. `{ reportId, status }`). */
  resultIdField?: string;
}

/** TZ §18 — `@Audit({ object: 'Driver', action: 'UPDATE' })`. */
export const Audit = (options: AuditOptions) =>
  SetMetadata<string, AuditOptions>(AUDIT_METADATA_KEY, options);
