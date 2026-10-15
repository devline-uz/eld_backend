import { PERMISSION_KEYS } from '../../common/decorators/permission.types';
import { DEFAULT_ROLE_MATRIX } from './permission-matrix';
import { PermissionMatrixDto } from './dto/roles.dto';
import { levelsOf } from './permission-ceiling';

describe('DEFAULT_ROLE_MATRIX (TZ §6.4 — 22-key matrix, all 4 roles)', () => {
  const roles = Object.keys(DEFAULT_ROLE_MATRIX) as (keyof typeof DEFAULT_ROLE_MATRIX)[];

  it('defines exactly the 5 seeded roles', () => {
    expect(roles.sort()).toEqual(['ADMIN', 'DISPATCHER', 'FLEET_MANAGER', 'SUPER_ADMIN', 'VIEWER']);
  });

  it.each(roles)('%s has all 22 permission keys with a valid level', (role) => {
    const matrix = DEFAULT_ROLE_MATRIX[role];
    expect(Object.keys(matrix).sort()).toEqual([...PERMISSION_KEYS].sort());
    for (const level of Object.values(matrix)) {
      expect(['NONE', 'READ', 'FULL']).toContain(level);
    }
  });

  it('ADMIN is FULL on every live key; the retired hosCertifyOnBehalf is NONE (CODE-029)', () => {
    for (const [key, level] of Object.entries(DEFAULT_ROLE_MATRIX.ADMIN)) {
      expect(level).toBe(key === 'hosCertifyOnBehalf' ? 'NONE' : 'FULL');
    }
  });

  it('tz.md correction 1: reportsTransfer is NONE (not READ) for DISPATCHER', () => {
    expect(DEFAULT_ROLE_MATRIX.DISPATCHER.reportsTransfer).toBe('NONE');
  });

  it('CODE-085: DISPATCHER has no dvir / maintenance / safety / devices access', () => {
    const d = DEFAULT_ROLE_MATRIX.DISPATCHER;
    expect([d.dvir, d.maintenance, d.safety, d.devices]).toEqual(['NONE', 'NONE', 'NONE', 'NONE']);
    // It keeps the reports it uses (Activity) — the DVIR report additionally needs `dvir`.
    expect(d.reports).toBe('READ');
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

describe('CODE-029 — retired hosCertifyOnBehalf', () => {
  it('a role write accepts the key from old clients but always stores NONE, and may omit it', () => {
    const full = Object.fromEntries(Object.keys(DEFAULT_ROLE_MATRIX.ADMIN).map((k) => [k, 'FULL']));
    expect(PermissionMatrixDto.parse(full).hosCertifyOnBehalf).toBe('NONE');
    const { hosCertifyOnBehalf: _omitted, ...withoutKey } = full;
    expect(PermissionMatrixDto.parse(withoutKey).hosCertifyOnBehalf).toBe('NONE');
  });

  it('a stored FULL never counts against a permission ceiling', () => {
    expect(levelsOf({ hosCertifyOnBehalf: 'FULL', hos: 'READ' })).toMatchObject({ hosCertifyOnBehalf: 'NONE', hos: 'READ' });
  });
});
