/**
 * TZ §6.4 — the 22-key permission matrix, keys are contract, do not rename.
 * `dataTransfer` (B-95, backend_tasks.md §20 row 850) is an additive 23rd key that splits
 * "send the eRODS/FMCSA data transfer" out of `reportsTransfer` ("export the FMCSA/report
 * pack"), so a role can be given one without the other — 11.19 role creation needs both
 * separately. `reportsTransfer` itself is unchanged (still exactly the §6.4 22 keys).
 */
export const PERMISSION_KEYS = [
  'dashboard',
  'liveFleet',
  'vehicles',
  'drivers',
  'hos',
  'hosEdit',
  'hosCertifyOnBehalf',
  'dvir',
  'maintenance',
  'safety',
  'trips',
  'reports',
  'reportsTransfer',
  'messaging',
  'devices',
  'alertRules',
  'users',
  'roles',
  'integrations',
  'auditLog',
  'support',
  'carrierSettings',
  'dataTransfer',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionLevel = 'NONE' | 'READ' | 'FULL';
export type PermissionMatrix = Record<PermissionKey, PermissionLevel>;
