import { PERMISSION_KEYS } from '../../common/decorators/permission.types';
import { DEFAULT_ROLE_MATRIX } from './permission-matrix';

describe('DEFAULT_ROLE_MATRIX (TZ §6.4 — 22-key matrix, all 4 roles)', () => {
  const roles = Object.keys(DEFAULT_ROLE_MATRIX) as (keyof typeof DEFAULT_ROLE_MATRIX)[];

  it('defines exactly the 4 seeded roles', () => {
    expect(roles.sort()).toEqual(['ADMIN', 'DISPATCHER', 'FLEET_MANAGER', 'VIEWER']);
  });

  it.each(roles)('%s has all 22 permission keys with a valid level', (role) => {
    const matrix = DEFAULT_ROLE_MATRIX[role];
    expect(Object.keys(matrix).sort()).toEqual([...PERMISSION_KEYS].sort());
    for (const level of Object.values(matrix)) {
      expect(['NONE', 'READ', 'FULL']).toContain(level);
    }
  });

  it('ADMIN is FULL on every key', () => {
    for (const level of Object.values(DEFAULT_ROLE_MATRIX.ADMIN)) expect(level).toBe('FULL');
  });

  it('tz.md correction 1: reportsTransfer is NONE (not READ) for DISPATCHER', () => {
    expect(DEFAULT_ROLE_MATRIX.DISPATCHER.reportsTransfer).toBe('NONE');
  });

  it('tz.md correction 2: trips is FULL for DISPATCHER', () => {
    expect(DEFAULT_ROLE_MATRIX.DISPATCHER.trips).toBe('FULL');
  });

  it('FLEET_MANAGER has NONE on users/roles/integrations/auditLog/carrierSettings', () => {
    for (const key of ['users', 'roles', 'integrations', 'auditLog', 'carrierSettings'] as const) {
      expect(DEFAULT_ROLE_MATRIX.FLEET_MANAGER[key]).toBe('NONE');
    }
  });

  it('VIEWER is read-only or none everywhere (never FULL)', () => {
    for (const level of Object.values(DEFAULT_ROLE_MATRIX.VIEWER)) expect(level).not.toBe('FULL');
  });
});
