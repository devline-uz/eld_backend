import { SetMetadata } from '@nestjs/common';
import { PermissionKey, PermissionLevel } from './permission.types';

export const PERM_METADATA_KEY = 'onebook:perm';

export interface PermRequirement {
  key: PermissionKey;
  level: Exclude<PermissionLevel, 'NONE'>;
}

/** Declares the permission a handler requires. Enforced by PermissionGuard (TZ §6.4). */
export const Perm = (key: PermissionKey, level: Exclude<PermissionLevel, 'NONE'> = 'READ') =>
  SetMetadata<string, PermRequirement>(PERM_METADATA_KEY, { key, level });
