import { SetMetadata } from '@nestjs/common';
import { PermissionKey, PermissionLevel } from './permission.types';

export const PERM_METADATA_KEY = 'onebook:perm';

export interface PermRequirement {
  key: PermissionKey;
  level: Exclude<PermissionLevel, 'NONE'>;
}

/** B-13 — `POST /vehicles/:id/assign-driver` accepts `vehicles:FULL` **or** `trips:FULL`
 * (a dispatcher only has the latter). `PermissionGuard` grants access if ANY requirement in
 * the array is met; a single `PermRequirement` (the overwhelmingly common case) keeps working
 * unchanged. */
export type PermRequirementSet = PermRequirement | PermRequirement[];

/** Declares the permission a handler requires. Enforced by PermissionGuard (TZ §6.4).
 * Pass an array of `[key, level]` pairs via `PermAny` for an OR requirement. */
export const Perm = (key: PermissionKey, level: Exclude<PermissionLevel, 'NONE'> = 'READ') =>
  SetMetadata<string, PermRequirementSet>(PERM_METADATA_KEY, { key, level });

/** B-13 — OR-requirement: passes if the caller meets ANY of the given `[key, level]` pairs. */
export const PermAny = (...requirements: [PermissionKey, Exclude<PermissionLevel, 'NONE'>][]) =>
  SetMetadata<string, PermRequirementSet>(
    PERM_METADATA_KEY,
    requirements.map(([key, level]) => ({ key, level })),
  );
