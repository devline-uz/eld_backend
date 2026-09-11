import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { AUDIT_METADATA_KEY, AuditOptions } from '../../common/decorators/audit.decorator';
import { ApiKeysController } from './api-keys.controller';

function permOf(method: keyof ApiKeysController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, ApiKeysController.prototype[method]) as
    | PermRequirement
    | undefined;
}

function auditOf(method: keyof ApiKeysController): AuditOptions | undefined {
  return Reflect.getMetadata(AUDIT_METADATA_KEY, ApiKeysController.prototype[method]) as
    | AuditOptions
    | undefined;
}

/**
 * TZ §6.4/§6.5 — every /api-keys endpoint is gated by the `integrations` permission key
 * (ADMIN-only per the matrix: only ADMIN grants FULL/READ on `integrations`, every other
 * seeded role is NONE). The generic cross-role 403 sweep for the `integrations` key itself
 * lives in `common/guards/permission.guard.spec.ts`, which is table-driven off
 * `DEFAULT_ROLE_MATRIX` for every key including this one — this suite only pins down that
 * each handler declares the right key/level and, separately, the right `@Audit()` metadata
 * (TZ §18: key creation, scope change and revocation are all audited).
 */
describe('ApiKeysController permissions + audit metadata', () => {
  it.each([
    ['list', 'READ'],
    ['create', 'FULL'],
    ['updateScopes', 'FULL'],
    ['revoke', 'FULL'],
  ] as const)('%s requires integrations:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'integrations', level });
  });

  it.each([
    ['create', { object: 'ApiKey', action: 'CREATE' }],
    ['updateScopes', { object: 'ApiKey', action: 'UPDATE_SCOPES' }],
    ['revoke', { object: 'ApiKey', action: 'REVOKE' }],
  ] as const)('%s is @Audit()-ed', (method, expected) => {
    expect(auditOf(method)).toEqual(expected);
  });

  it('list is a read-only endpoint — never audited', () => {
    expect(auditOf('list')).toBeUndefined();
  });
});
