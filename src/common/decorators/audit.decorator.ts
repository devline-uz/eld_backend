import { SetMetadata } from '@nestjs/common';

export const AUDIT_METADATA_KEY = 'onebook:audit';

export interface AuditOptions {
  /** Entity name, e.g. 'Driver'. */
  object: string;
  /** Verb recorded in AuditLog.action, e.g. 'UPDATE'. */
  action: string;
  /** Route param that holds the object id; defaults to 'id'. */
  idParam?: string;
}

/** TZ §18 — `@Audit({ object: 'Driver', action: 'UPDATE' })`. */
export const Audit = (options: AuditOptions) =>
  SetMetadata<string, AuditOptions>(AUDIT_METADATA_KEY, options);
