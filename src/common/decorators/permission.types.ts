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

/** NONE < READ < FULL — the one ordering every level comparison uses. */
export const PERMISSION_LEVEL_RANK: Readonly<Record<PermissionLevel, number>> = { NONE: 0, READ: 1, FULL: 2 };

/**
 * CODE-029 — keys kept in the contract (stored role rows and older clients still carry them) but
 * no longer granting anything: certification is driver-only, so `hosCertifyOnBehalf` is always
 * read and stored as NONE. Never remove a key here; retire it.
 */
export const RETIRED_PERMISSION_KEYS = ['hosCertifyOnBehalf'] as const satisfies readonly PermissionKey[];

/** Forces every retired key to NONE — applied to role writes and to the live permission matrix. */
export function withRetiredKeysCleared<T extends Partial<Record<PermissionKey, PermissionLevel>>>(matrix: T): T {
  const out = { ...matrix };
  for (const key of RETIRED_PERMISSION_KEYS) {
    if (key in out) (out as Record<string, PermissionLevel>)[key] = 'NONE';
  }
  return out;
}

