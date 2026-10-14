import type { Role } from '@prisma/client';
import {
  PERMISSION_KEYS,
  RETIRED_PERMISSION_KEYS,
  PERMISSION_LEVEL_RANK,
  PermissionKey,
  PermissionLevel,
  PermissionMatrix,
} from '../../common/decorators/permission.types';
import { AppException } from '../../common/errors/app.exception';

/**
 * CODE-002 / CODE-003 — "you can only hand out what you hold". Whoever authors a role matrix,
 * assigns a role or mints API-key scopes is capped, key by key, at their *own* current level.
 * SUPER_ADMIN is the only exemption. The actor's level is read from the DB (the role they hold
 * right now), not from the possibly stale `per` token claim.
 */
export const SUPER_ADMIN_ROLE_KEY = 'SUPER_ADMIN';

export type PermissionLevels = Partial<Record<PermissionKey, PermissionLevel>>;

export interface PermissionCeiling {
  /** SUPER_ADMIN — exempt from every ceiling check. */
  unrestricted: boolean;
  /** Id of the role the actor holds (undefined for an API-key principal). */
  roleId?: string;
  levels: PermissionMatrix;
}

/** The subset of `ContextUser` the ceiling needs (what `@CurrentUser()` injects). */
export interface CeilingActor {
  id: string;
  type?: 'user' | 'driver' | 'api-key';
  permissions?: Readonly<Record<string, PermissionLevel>>;
}

export interface UserRoleLookup {
  findRoleOfUser(userId: string): Promise<Role | null>;
}

const isLevel = (v: unknown): v is PermissionLevel => v === 'NONE' || v === 'READ' || v === 'FULL';

/** Normalizes a stored/claimed matrix (Prisma `Json`) — any missing or malformed key is NONE. */
const RETIRED = new Set<string>(RETIRED_PERMISSION_KEYS);

export function levelsOf(matrix: unknown): PermissionMatrix {
  const source = (matrix && typeof matrix === 'object' ? matrix : {}) as Record<string, unknown>;
  return Object.fromEntries(
    // CODE-029 — a retired key grants nothing, so it never counts against a ceiling either.
    PERMISSION_KEYS.map((key) => [key, !RETIRED.has(key) && isLevel(source[key]) ? source[key] : 'NONE']),
  ) as PermissionMatrix;
}

/** Key-by-key minimum of two matrices. */
export function minLevels(a: PermissionLevels, b: PermissionLevels): PermissionMatrix {
  return Object.fromEntries(
    PERMISSION_KEYS.map((key) => {
      const la = a[key] ?? 'NONE';
      const lb = b[key] ?? 'NONE';
      return [key, PERMISSION_LEVEL_RANK[la] <= PERMISSION_LEVEL_RANK[lb] ? la : lb];
    }),
  ) as PermissionMatrix;
}

export interface ExceedingPermission {
  key: PermissionKey;
  requested: PermissionLevel;
  allowed: PermissionLevel;
}

/** Keys where `requested` is above the ceiling (always empty for an unrestricted ceiling). */
export function exceedingPermissions(requested: PermissionLevels, ceiling: PermissionCeiling): ExceedingPermission[] {
  if (ceiling.unrestricted) return [];
  const out: ExceedingPermission[] = [];
  for (const key of PERMISSION_KEYS) {
    const level = requested[key];
    if (level && PERMISSION_LEVEL_RANK[level] > PERMISSION_LEVEL_RANK[ceiling.levels[key]]) {
      out.push({ key, requested: level, allowed: ceiling.levels[key] });
    }
  }
  return out;
}

/** 403 FORBIDDEN listing every key above the actor's own level. */
export function assertWithinCeiling(requested: PermissionLevels, ceiling: PermissionCeiling, message: string): void {
  const exceeding = exceedingPermissions(requested, ceiling);
  if (exceeding.length === 0) return;
  const list = exceeding.map((e) => `${e.key} (${e.requested}, you have ${e.allowed})`).join(', ');
  throw AppException.forbidden(`${message}: ${list}.`, { exceeding });
}

/**
 * The actor's current ceiling. A back-office user's comes from the role they hold in the DB
 * (an inactive or missing user gets a 403, fail closed); an API-key principal's from its scope
 * matrix (already capped at its creator's role by `ApiKeysAuthAdapter`).
 */
export async function resolveCeiling(actor: CeilingActor | undefined, lookup: UserRoleLookup): Promise<PermissionCeiling> {
  if (!actor?.id) throw AppException.forbidden('Could not determine your permissions.');
  if (actor.type === 'api-key') return { unrestricted: false, levels: levelsOf(actor.permissions) };
  const role = await lookup.findRoleOfUser(actor.id);
  if (!role) throw AppException.forbidden('Could not determine your permissions.');
  return { unrestricted: role.key === SUPER_ADMIN_ROLE_KEY, roleId: role.id, levels: levelsOf(role.permissions) };
}
