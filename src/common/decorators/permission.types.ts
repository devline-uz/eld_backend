/** TZ §6.4 — the 22-key permission matrix. Keys are contract, do not rename. */
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
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionLevel = 'NONE' | 'READ' | 'FULL';
export type PermissionMatrix = Record<PermissionKey, PermissionLevel>;
