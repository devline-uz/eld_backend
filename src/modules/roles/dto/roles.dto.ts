import { z } from 'zod';
import { PERMISSION_KEYS } from '../../../common/decorators/permission.types';

const PermissionLevelSchema = z.enum(['NONE', 'READ', 'FULL']);

/** All 22 keys required — TZ §6.4 "22 kalitning hammasi". */
export const PermissionMatrixDto = z.object(
  Object.fromEntries(PERMISSION_KEYS.map((k) => [k, PermissionLevelSchema])) as Record<
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
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  permissions: PermissionMatrixDto,
});
export type CreateRoleDto = z.infer<typeof CreateRoleDto>;

export const UpdateRoleDto = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  permissions: PermissionMatrixDto.optional(),
});
export type UpdateRoleDto = z.infer<typeof UpdateRoleDto>;
