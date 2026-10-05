import { PermissionKey, PermissionLevel, PermissionMatrix } from '../../common/decorators/permission.types';

export { PERMISSION_KEYS } from '../../common/decorators/permission.types';

/**
 * TZ §6.4 — the 22-key permission matrix, verbatim, for the four seeded roles.
 * `reportsTransfer` is `NONE` for DISPATCHER (not READ) and `trips` is `FULL` for
 * DISPATCHER — both called out explicitly in tz.md as corrections to an earlier draft.
 * `prisma/seed.ts` seeds the DB with this exact data; this module is the single source of
 * truth the API reads/validates against, and the seed-shape integration test cross-checks
 * the two never drift apart.
 */
const PERMISSION_KEY_LIST: PermissionKey[] = [
  'dashboard', 'liveFleet', 'vehicles', 'drivers', 'hos', 'hosEdit',
  'hosCertifyOnBehalf', 'dvir', 'maintenance', 'safety', 'trips',
  'reports', 'reportsTransfer', 'messaging', 'devices', 'alertRules',
  'users', 'roles', 'integrations', 'auditLog', 'support', 'carrierSettings',
  // B-95 — additive 23rd key, split from `reportsTransfer` (see permission.types.ts).
  'dataTransfer',
];

function allFull(): PermissionMatrix {
  const level: PermissionLevel = 'FULL';
  return Object.fromEntries(PERMISSION_KEY_LIST.map((k) => [k, level])) as PermissionMatrix;
}

export const DEFAULT_ROLE_MATRIX: Record<'SUPER_ADMIN' | 'ADMIN' | 'FLEET_MANAGER' | 'DISPATCHER' | 'VIEWER', PermissionMatrix> = {
  SUPER_ADMIN: allFull(),
  ADMIN: allFull(),
  FLEET_MANAGER: {
    dashboard: 'FULL', liveFleet: 'FULL', vehicles: 'FULL', drivers: 'FULL', hos: 'FULL',
    hosEdit: 'FULL', hosCertifyOnBehalf: 'NONE', dvir: 'FULL', maintenance: 'FULL',
    safety: 'FULL', trips: 'FULL', reports: 'FULL', reportsTransfer: 'FULL', messaging: 'FULL',
    devices: 'FULL', alertRules: 'FULL', users: 'NONE', roles: 'NONE', integrations: 'NONE',
    auditLog: 'NONE', support: 'FULL', carrierSettings: 'NONE', dataTransfer: 'FULL',
  },
  DISPATCHER: {
    dashboard: 'FULL', liveFleet: 'FULL', vehicles: 'READ', drivers: 'READ', hos: 'READ',
    hosEdit: 'NONE', hosCertifyOnBehalf: 'NONE', dvir: 'READ', maintenance: 'READ',
    safety: 'READ', trips: 'FULL', reports: 'READ', reportsTransfer: 'NONE', messaging: 'FULL',
    devices: 'READ', alertRules: 'NONE', users: 'NONE', roles: 'NONE', integrations: 'NONE',
    auditLog: 'NONE', support: 'FULL', carrierSettings: 'NONE', dataTransfer: 'NONE',
  },
  VIEWER: {
    dashboard: 'READ', liveFleet: 'READ', vehicles: 'READ', drivers: 'READ', hos: 'READ',
    hosEdit: 'NONE', hosCertifyOnBehalf: 'NONE', dvir: 'READ', maintenance: 'READ',
    safety: 'READ', trips: 'NONE', reports: 'READ', reportsTransfer: 'NONE', messaging: 'NONE',
    devices: 'NONE', alertRules: 'NONE', users: 'NONE', roles: 'NONE', integrations: 'NONE',
    auditLog: 'NONE', support: 'READ', carrierSettings: 'NONE', dataTransfer: 'NONE',
  },
};
