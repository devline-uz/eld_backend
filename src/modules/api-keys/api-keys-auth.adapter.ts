import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { ApiKeyVerifier } from '../../common/guards/api-key-verifier.port';
import { PERMISSION_KEYS, PermissionKey, PermissionMatrix } from '../../common/decorators/permission.types';
import { ApiKeysService } from './api-keys.service';

/**
 * Real binding for the transport-level `ApiKeyVerifier` port (TZ §6.5, §11.7). A key's
 * `scopes` array holds `"<permissionKey>:<READ|FULL>"` strings (validated at write time by
 * `CreateApiKeyDto`/`UpdateApiKeyScopesDto`); every permission key not named by a scope is
 * `NONE`. Malformed scopes (only possible if written before validation existed, or via a
 * direct DB edit) are ignored rather than rejected here, so a stale key degrades to fewer
 * permissions instead of failing to verify.
 */
@Injectable()
export class ApiKeysAuthAdapter extends ApiKeyVerifier {
  constructor(private readonly apiKeys: ApiKeysService) {
    super();
  }

  async verify(plaintextKey: string): Promise<ContextUser> {
    const key = await this.apiKeys.verify(plaintextKey);
    return {
      id: key.id,
      type: 'api-key',
      permissions: scopesToPermissionMatrix(key.scopes),
    };
  }
}

function scopesToPermissionMatrix(scopes: string[]): PermissionMatrix {
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
