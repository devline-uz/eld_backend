import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { ApiKeyVerifier } from '../../common/guards/api-key-verifier.port';
import { levelsOf, minLevels, SUPER_ADMIN_ROLE_KEY } from '../roles/permission-ceiling';
import { scopesToPermissionMatrix } from './api-key-scopes';
import { ApiKeysService } from './api-keys.service';

/**
 * Real binding for the transport-level `ApiKeyVerifier` port (TZ §6.5, §11.7). The key's
 * scope matrix (`scopesToPermissionMatrix`) is additionally capped, key by key, at the
 * creator's *current* role (CODE-003), so a key never outranks the person who minted it —
 * including keys minted before scopes were capped at create time, and creators demoted since.
 */
@Injectable()
export class ApiKeysAuthAdapter extends ApiKeyVerifier {
  constructor(private readonly apiKeys: ApiKeysService) {
    super();
  }

  async verify(plaintextKey: string): Promise<ContextUser> {
    const key = await this.apiKeys.verify(plaintextKey);
    const scoped = scopesToPermissionMatrix(key.scopes);
    const creatorRole = key.createdBy.role;
    return {
      id: key.id,
      type: 'api-key',
      permissions: creatorRole.key === SUPER_ADMIN_ROLE_KEY ? scoped : minLevels(scoped, levelsOf(creatorRole.permissions)),
    };
  }
}
