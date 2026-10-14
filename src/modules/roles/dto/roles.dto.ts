import { z } from 'zod';
import { PERMISSION_KEYS, RETIRED_PERMISSION_KEYS } from '../../../common/decorators/permission.types';

const PermissionLevelSchema = z.enum(['NONE', 'READ', 'FULL']);

const RETIRED = new Set<string>(RETIRED_PERMISSION_KEYS);
/** Retired keys (CODE-029) are accepted for old clients but always stored as NONE. */
const RetiredLevelSchema = PermissionLevelSchema.optional().transform(() => 'NONE' as const);

/** All live keys required — TZ §6.4 "22 kalitning hammasi"; retired keys optional, forced NONE. */
export const PermissionMatrixDto = z.object(
  Object.fromEntries(PERMISSION_KEYS.map((k) => [k, RETIRED.has(k) ? RetiredLevelSchema : PermissionLevelSchema])) as Record<
    (typeof PERMISSION_KEYS)[number],
    typeof PermissionLevelSchema
  >,
);
export type PermissionMatrixDto = z.infer<typeof PermissionMatrixDto>;

export const CreateRoleDto = z.object({
  key: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'key must be SCREAMING_SNAKE_CASE'),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  permissions: PermissionMatrixDto,
});
export type CreateRoleDto = z.infer<typeof CreateRoleDto>;

export const UpdateRoleDto = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  permissions: PermissionMatrixDto.optional(),
});
export type UpdateRoleDto = z.infer<typeof UpdateRoleDto>;
