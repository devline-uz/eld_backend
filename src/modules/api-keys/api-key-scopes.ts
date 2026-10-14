import { PERMISSION_KEYS, PermissionKey, PermissionMatrix } from '../../common/decorators/permission.types';

/**
 * A key's `scopes` array holds `"<permissionKey>:<READ|FULL>"` strings (validated at write time
 * by `CreateApiKeyDto`/`UpdateApiKeyScopesDto`); every permission key not named by a scope is
 * `NONE`. Malformed scopes (only possible if written before validation existed, or via a direct
 * DB edit) are ignored rather than rejected, so a stale key degrades to fewer permissions.
 */
export function scopesToPermissionMatrix(scopes: string[]): PermissionMatrix {
  const granted = new Map<string, 'READ' | 'FULL'>();
  for (const scope of scopes) {
    const [key, level] = scope.split(':');
    const upperLevel = level?.toUpperCase();
    if (
      (PERMISSION_KEYS as readonly string[]).includes(key) &&
      (upperLevel === 'READ' || upperLevel === 'FULL')
    ) {
      // FULL should never be downgraded by a later/duplicate READ scope for the same key.
      if (upperLevel === 'FULL' || granted.get(key) !== 'FULL') granted.set(key, upperLevel);
    }
  }
  return Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, granted.get(key) ?? 'NONE']),
  ) as Record<PermissionKey, 'NONE' | 'READ' | 'FULL'>;
}
