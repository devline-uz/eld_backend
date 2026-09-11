import { z } from 'zod';
import { PERMISSION_KEYS } from '../../../common/decorators/permission.types';

/**
 * TZ §11.7 `/api-keys`, §6.5 — scopes reuse the 22-key permission vocabulary + a level, as
 * `"<permissionKey>:<READ|FULL>"` (e.g. `"reports:read"`, level is case-insensitive).
 * Validated here so a typo'd scope is rejected at write time (§20 `VALIDATION_FAILED`)
 * instead of silently granting nothing when the key is later used
 * (`ApiKeysAuthAdapter#scopesToPermissionMatrix`).
 */
const SCOPE_PATTERN = new RegExp(`^(${PERMISSION_KEYS.join('|')}):(READ|FULL)$`, 'i');
const ApiKeyScope = z
  .string()
  .regex(SCOPE_PATTERN, 'Scope must be "<permissionKey>:<READ|FULL>", e.g. "reports:read".');

export const CreateApiKeyDto = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(ApiKeyScope).min(1),
  expiresAt: z.string().datetime().optional(),
});
export type CreateApiKeyDto = z.infer<typeof CreateApiKeyDto>;

/** TZ §6.5 — scope change is a first-class, audited action, separate from create/revoke. */
export const UpdateApiKeyScopesDto = z.object({
  scopes: z.array(ApiKeyScope).min(1),
});
export type UpdateApiKeyScopesDto = z.infer<typeof UpdateApiKeyScopesDto>;
