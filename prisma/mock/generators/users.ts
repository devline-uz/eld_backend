/**
 * OneBook ELD — mock generator: users.
 *
 * Owns: panel users (ADMIN/FLEET_MANAGER/DISPATCHER/VIEWER + a handful of carrier-custom
 * roles), sessions, API keys and the audit log (tz.md §6, §18). See prisma/mock/README.md
 * for the shared contract this module must honour (idempotency, mock-identity, no future
 * timestamps, batched inserts).
 *
 * Idempotent re-run strategy (B-059/D-076): every mock row gets a deterministic id derived
 * from a stable natural key via `mockId(domain, naturalKey)` (User: email; Role: key; Session:
 * `email:planIndex`; ApiKey: `email:planIndex`) and is upserted on that id, NEVER
 * deleted-then-recreated — a delete+recreate cycle changes the row's id every run, which
 * silently orphans every `AuditLog` row that named the old id, and `AuditLog` cannot be
 * repaired after the fact (UPDATE/DELETE revoked at the DB level). Nothing outside this
 * identity is ever touched — the 12 seeded users and the 4 system roles are read-only to this
 * generator.
 */
import { AuthProvider, EditorType, Prisma, UserStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { MockContext, MOCK_TAG, MOCK_EMAIL_DOMAIN, clampToNow, mockId } from '../context';
import { hashPassword } from '../../../src/modules/auth/lib/password.util';
import { sha256 } from '../../../src/modules/auth/lib/hash.util';
import { PERMISSION_KEYS, PermissionKey, PermissionMatrix } from '../../../src/common/decorators/permission.types';
import { DEFAULT_ROLE_MATRIX } from '../../../src/modules/roles/permission-matrix';

/** Every mock-owned custom Role.key starts with this — the sole identity used to find this
 * generator's roles on re-run (system role keys are plain e.g. "ADMIN", never this prefix). */
export const MOCK_ROLE_PREFIX = 'MOCK_ROLE_';

const BATCH = 5000;

/** Upsert a batch with bounded concurrency — Prisma has no bulk-upsert primitive (same pattern
 * as `core.ts`'s `upsertAll`, re-implemented locally rather than imported so this generator
 * never depends on another agent's file). */
async function upsertAll<T>(items: T[], fn: (item: T) => Promise<unknown>, concurrency = 20): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

// ---------------------------------------------------------------------------
// Pure builders — no DB, no Date.now() (all take `now`/`from`/`to` explicitly) so they are
// deterministic and unit-testable from a plain jest spec.
// ---------------------------------------------------------------------------

export type BaseRoleKey = 'ADMIN' | 'FLEET_MANAGER' | 'DISPATCHER' | 'VIEWER';

export interface MockRoleDef {
  key: string;
  name: string;
  description: string;
  permissions: PermissionMatrix;
}

/** tz §6.4 — variant matrices, each a deliberate, documented departure from one of the four
 * default role matrices (never a random mutation) so a reviewer can see exactly what a
 * carrier-defined role changes relative to its closest system role. */
export function buildMockRoleDefs(): MockRoleDef[] {
  const overlay = (base: PermissionMatrix, patch: Partial<PermissionMatrix>): PermissionMatrix => ({ ...base, ...patch });

  return [
    {
      key: `${MOCK_ROLE_PREFIX}SAFETY_MANAGER`,
      name: 'Safety Manager',
      description: `[${MOCK_TAG}] Owns safety events, HOS edits and DVIR review; no user/role/carrier admin.`,
      permissions: overlay(DEFAULT_ROLE_MATRIX.FLEET_MANAGER, {
        safety: 'FULL', hosEdit: 'FULL', hosCertifyOnBehalf: 'FULL', dvir: 'FULL',
        maintenance: 'READ', trips: 'NONE', vehicles: 'READ', reportsTransfer: 'NONE',
        alertRules: 'FULL', users: 'NONE',
      }),
    },
    {
      key: `${MOCK_ROLE_PREFIX}ACCOUNTING`,
      name: 'Accounting',
      description: `[${MOCK_TAG}] Reports + transfers + integrations read; no fleet/HOS operational access.`,
      permissions: overlay(DEFAULT_ROLE_MATRIX.VIEWER, {
        reports: 'FULL', reportsTransfer: 'FULL', integrations: 'READ',
        liveFleet: 'NONE', dvir: 'NONE', maintenance: 'NONE', safety: 'NONE',
      }),
    },
    {
      key: `${MOCK_ROLE_PREFIX}DISPATCH_READONLY`,
      name: 'Dispatch (Read Only)',
      description: `[${MOCK_TAG}] Like Dispatcher but cannot create/assign trips or broadcast messages.`,
      permissions: overlay(DEFAULT_ROLE_MATRIX.DISPATCHER, { trips: 'READ', messaging: 'READ' }),
    },
    {
      key: `${MOCK_ROLE_PREFIX}FLEET_OPS_LITE`,
      name: 'Fleet Ops (Lite)',
      description: `[${MOCK_TAG}] Fleet Manager minus maintenance write and DVIR write.`,
      permissions: overlay(DEFAULT_ROLE_MATRIX.FLEET_MANAGER, { maintenance: 'READ', dvir: 'READ', devices: 'READ' }),
    },
    {
      key: `${MOCK_ROLE_PREFIX}VIEWER_PLUS_MESSAGING`,
      name: 'Viewer Plus Messaging',
      description: `[${MOCK_TAG}] Viewer with read access to messaging added (per-user override request).`,
      permissions: overlay(DEFAULT_ROLE_MATRIX.VIEWER, { messaging: 'READ' }),
    },
  ];
}

const FIRST_NAMES = [
  'Alicia', 'Marcus', 'Grace', 'Derek', 'Sofia', 'Tyler', 'Renee', 'Omar', 'Paula', 'Ivan',
  'Nadia', 'Chris', 'Elena', 'Hassan', 'Jenna', 'Victor', 'Mia', 'Aaron', 'Laila', 'Scott',
  'Yolanda', 'Felix', 'Bianca', 'Wesley', 'Cassie', 'Roman', 'Tara', 'Luis', 'Heidi', 'Andre',
  'Simone', 'Neil', 'Ruby', 'Gavin', 'Dana', 'Miguel', 'Kelsey', 'Otis', 'Fiona', 'Dean',
];
const LAST_NAMES = [
  'Barrett', 'Fontaine', 'Whitfield', 'Osei', 'Larsen', 'Mancini', 'Schuler', 'Pruitt', 'Alvarez',
  'Nakamura', 'Delgado', 'Voss', 'Okafor', 'Bianchi', 'Hutton', 'Marlowe', 'Kessler', 'Rourke',
  'Santini', 'Ferreira', 'Callahan', 'Novak', 'Abara', 'Whitman', 'Solis', 'Dubois', 'Iverson',
];
const JOB_TITLES: Record<BaseRoleKey, string[]> = {
  ADMIN: ['Fleet Administrator', 'Ops Administrator', 'IT Administrator', 'Compliance Administrator'],
  FLEET_MANAGER: ['Fleet Manager', 'Regional Fleet Manager', 'Terminal Manager', 'Operations Manager'],
  DISPATCHER: ['Dispatcher', 'Senior Dispatcher', 'Load Planner', 'Dispatch Supervisor'],
  VIEWER: ['Safety Analyst', 'Compliance Viewer', 'Accounting', 'Auditor (Read Only)', 'Customer Service'],
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/126.0.0.0',
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/605.1.15',
];
const DEVICE_LABELS = ['Chrome on Windows', 'Safari on macOS', 'Chrome on Linux', 'Safari on iPhone', 'Edge on Windows', 'Safari on iPad'];

export interface MockUserPlan {
  index: number;
  email: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  roleKey: string;
  authProvider: AuthProvider;
  status: UserStatus;
  createdAt: Date;
  lastActiveAt: Date | null;
  invitedAt: Date | null;
}

/**
 * Builds the ~40-user plan: role distribution ADMIN(3)/FLEET_MANAGER(10)/DISPATCHER(12)/
 * VIEWER(10)/custom(5), with a status mix (mostly ACTIVE, some INVITED-not-accepted, a few
 * DISABLED) and a couple of GOOGLE-provider accounts. Pure and deterministic given `rng`.
 */
export function buildMockUserPlans(
  rng: MockContext['rng'],
  customRoleKeys: string[],
  from: Date,
  to: Date,
): MockUserPlan[] {
  const roleAssignments: string[] = [
    ...Array(3).fill('ADMIN'),
    ...Array(10).fill('FLEET_MANAGER'),
    ...Array(12).fill('DISPATCHER'),
    ...Array(10).fill('VIEWER'),
    ...customRoleKeys,
  ];
  const usedNames = new Set<string>();
  const plans: MockUserPlan[] = [];
  const fromDt = DateTime.fromJSDate(from);
  const toDt = DateTime.fromJSDate(to);

  roleAssignments.forEach((roleKey, index) => {
    let first: string;
    let last: string;
    let nameKey: string;
    do {
      first = rng.pick(FIRST_NAMES);
      last = rng.pick(LAST_NAMES);
      nameKey = `${first}.${last}`;
    } while (usedNames.has(nameKey));
    usedNames.add(nameKey);

    const email = `${first.toLowerCase()}.${last.toLowerCase()}${index}${MOCK_EMAIL_DOMAIN}`;
    const baseRole: BaseRoleKey = (['ADMIN', 'FLEET_MANAGER', 'DISPATCHER', 'VIEWER'] as const).includes(
      roleKey as BaseRoleKey,
    )
      ? (roleKey as BaseRoleKey)
      : 'VIEWER'; // custom roles borrow a Viewer-ish job title pool — closest analogue.
    const jobTitle = rng.pick(JOB_TITLES[baseRole]);

    // Status mix: ~70% ACTIVE, ~18% INVITED (never logged in), ~12% DISABLED.
    const roll = rng.next();
    const status: UserStatus = roll < 0.7 ? UserStatus.ACTIVE : roll < 0.88 ? UserStatus.INVITED : UserStatus.DISABLED;

    const createdAt = clampToNow(
      fromDt.plus({ days: rng.int(0, Math.max(1, Math.floor(toDt.diff(fromDt, 'days').days) - 1)) }).toJSDate(),
      { to } as MockContext,
    );
    const invitedAt = createdAt;
    const lastActiveAt =
      status === UserStatus.INVITED
        ? null
        : clampToNow(
            DateTime.fromJSDate(createdAt)
              .plus({ hours: rng.int(1, Math.max(1, Math.floor(toDt.diff(DateTime.fromJSDate(createdAt), 'hours').hours))) })
              .toJSDate(),
            { to } as MockContext,
          );

    const authProvider = rng.chance(0.15) ? AuthProvider.GOOGLE : AuthProvider.PASSWORD;

    plans.push({ index, email, firstName: first, lastName: last, jobTitle, roleKey, authProvider, status, createdAt, lastActiveAt, invitedAt });
  });

  return plans;
}

export interface MockSessionPlan {
  userIndex: number;
  userAgent: string;
  deviceLabel: string;
  ip: string;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** 0-3 sessions per active-enough user (INVITED users never logged in -> never get a session). */
export function buildMockSessionPlans(rng: MockContext['rng'], users: MockUserPlan[], to: Date): MockSessionPlan[] {
  const plans: MockSessionPlan[] = [];
  for (const u of users) {
    if (u.status === UserStatus.INVITED || !u.lastActiveAt) continue;
    const count = rng.int(1, 3);
    for (let i = 0; i < count; i++) {
      const lastSeenAt = clampToNow(
        DateTime.fromJSDate(u.lastActiveAt).minus({ hours: rng.int(0, 24 * 14) }).toJSDate(),
        { to } as MockContext,
      );
      const revoked = u.status === UserStatus.DISABLED ? true : rng.chance(0.25);
      const expiresAt = DateTime.fromJSDate(lastSeenAt).plus({ days: 30 }).toJSDate(); // tz §6 — User refresh 30d
      plans.push({
        userIndex: u.index,
        userAgent: rng.pick(USER_AGENTS),
        deviceLabel: rng.pick(DEVICE_LABELS),
        ip: `10.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
        lastSeenAt,
        expiresAt,
        revokedAt: revoked
          ? clampToNow(DateTime.fromJSDate(lastSeenAt).plus({ hours: rng.int(1, 48) }).toJSDate(), { to } as MockContext)
          : null,
      });
    }
  }
  return plans;
}

export interface MockApiKeyPlan {
  creatorIndex: number;
  name: string;
  scopes: string[];
  state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

const API_KEY_NAMES = [
  'Telematics feed', 'Fuel card import', 'BI dashboard export', 'ERP sync', 'Broker portal', 'Load board integration',
];

export function buildMockApiKeyPlans(rng: MockContext['rng'], creatorIndices: number[], to: Date): MockApiKeyPlan[] {
  const plans: MockApiKeyPlan[] = [];
  const states: MockApiKeyPlan['state'][] = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'REVOKED', 'REVOKED', 'EXPIRED'];
  states.forEach((state, i) => {
    const creatorIndex = creatorIndices[i % creatorIndices.length];
    const createdAt = clampToNow(DateTime.fromJSDate(to).minus({ days: rng.int(20, 170) }).toJSDate(), { to } as MockContext);
    const scopeCount = rng.int(1, 3);
    const scopes = rng.shuffle(PERMISSION_KEYS as readonly PermissionKey[])
      .slice(0, scopeCount)
      .map((k) => `${k}:${rng.chance(0.5) ? 'READ' : 'FULL'}`);
    const lastUsedAt = state === 'ACTIVE' ? clampToNow(DateTime.fromJSDate(createdAt).plus({ days: rng.int(1, 60) }).toJSDate(), { to } as MockContext) : null;
    const expiresAt =
      state === 'EXPIRED'
        ? clampToNow(DateTime.fromJSDate(createdAt).plus({ days: 30 }).toJSDate(), { to } as MockContext)
        : state === 'ACTIVE'
          ? DateTime.fromJSDate(to).plus({ days: 180 }).toJSDate() // scheduled expiry — allowed to be future, like a token's exp
          : null;
    const revokedAt = state === 'REVOKED' ? clampToNow(DateTime.fromJSDate(createdAt).plus({ days: rng.int(2, 40) }).toJSDate(), { to } as MockContext) : null;
    plans.push({ creatorIndex, name: `[${MOCK_TAG}] ${rng.pick(API_KEY_NAMES)}`, scopes, state, createdAt, lastUsedAt, expiresAt, revokedAt });
  });
  return plans;
}

export interface MockAuditPlan {
  actorId: string;
  actorType: EditorType;
  action: string;
  objectType: string;
  objectId: string;
  before: Prisma.InputJsonValue | null;
  after: Prisma.InputJsonValue | null;
  detail: string | null;
  createdAt: Date;
  ip: string;
  userAgent: string;
}

const AUDIT_ACTIONS: Array<{ action: string; objectType: string }> = [
  { action: 'LOGIN', objectType: 'User' },
  { action: 'INVITE', objectType: 'User' },
  { action: 'UPDATE', objectType: 'User' }, // role change (roleId diff)
  { action: 'CREATE', objectType: 'Vehicle' },
  { action: 'UPDATE', objectType: 'Vehicle' },
  { action: 'CALIBRATE_ODOMETER', objectType: 'Vehicle' },
  { action: 'CREATE', objectType: 'Driver' },
  { action: 'UPDATE', objectType: 'Driver' },
  { action: 'LOG_EDIT_REQUESTED', objectType: 'EldEvent' },
  { action: 'LOG_EDIT_ACCEPTED', objectType: 'EldEvent' },
  { action: 'LOG_EDIT_REJECTED', objectType: 'EldEvent' },
  { action: 'LOG_CERTIFIED', objectType: 'DailyLog' },
  { action: 'VIOLATION_RESOLVED', objectType: 'HosViolation' },
  { action: 'CREATE', objectType: 'Report' },
  { action: 'UPDATE', objectType: 'Carrier' }, // settings change
  { action: 'CREATE', objectType: 'ApiKey' },
  { action: 'REVOKE', objectType: 'ApiKey' },
  { action: 'CREATE', objectType: 'Role' },
  { action: 'UPDATE', objectType: 'Role' },
];

/**
 * Builds N synthetic-but-shaped audit rows spread uniformly over [from, to]. `objectIds` is a
 * pool per objectType the caller resolved from the live DB (mock + seed rows) so `objectId`
 * always looks like it points somewhere real; when a pool is empty the caller's actorId itself
 * is used as a harmless fallback (still a valid FK-less string — AuditLog has no FK).
 */
export function buildAuditPlans(
  rng: MockContext['rng'],
  count: number,
  actorIds: string[],
  objectIdsByType: Record<string, string[]>,
  from: Date,
  to: Date,
): MockAuditPlan[] {
  const plans: MockAuditPlan[] = [];
  const fromMs = from.getTime();
  const toMs = to.getTime();
  for (let i = 0; i < count; i++) {
    const { action, objectType } = rng.pick(AUDIT_ACTIONS);
    const pool = objectIdsByType[objectType];
    const objectId = pool && pool.length > 0 ? rng.pick(pool) : rng.pick(actorIds);
    const actorId = rng.pick(actorIds);
    const createdAt = new Date(fromMs + rng.next() * (toMs - fromMs));
    const { before, after, detail } = auditPayloadFor(action, objectType, objectId);
    plans.push({
      actorId,
      actorType: EditorType.USER,
      action,
      objectType,
      objectId,
      before,
      after,
      detail,
      createdAt,
      ip: `172.16.${rng.int(0, 255)}.${rng.int(1, 254)}`,
      userAgent: rng.pick(USER_AGENTS),
    });
  }
  return plans;
}

/** Small, deterministic before/after/detail shapes per action — same redacted shape the real
 * writer produces (no secret fields are ever included here in the first place). */
function auditPayloadFor(
  action: string,
  objectType: string,
  objectId: string,
): { before: Prisma.InputJsonValue | null; after: Prisma.InputJsonValue | null; detail: string | null } {
  switch (action) {
    case 'LOGIN':
      return { before: null, after: null, detail: `[${MOCK_TAG}] password login` };
    case 'INVITE':
      return { before: null, after: { status: 'INVITED' }, detail: `[${MOCK_TAG}] user invited` };
    case 'UPDATE':
      if (objectType === 'User') return { before: { roleId: 'role_old' }, after: { roleId: 'role_new' }, detail: `[${MOCK_TAG}] role change` };
      if (objectType === 'Vehicle') return { before: { status: 'ACTIVE' }, after: { status: 'ACTIVE', odometerMi: 1000 }, detail: `[${MOCK_TAG}] vehicle update` };
      if (objectType === 'Driver') return { before: { status: 'ACTIVE' }, after: { status: 'ACTIVE' }, detail: `[${MOCK_TAG}] driver update` };
      if (objectType === 'Carrier') return { before: { unassignedThresholdMin: 3 }, after: { unassignedThresholdMin: 5 }, detail: `[${MOCK_TAG}] carrier settings change` };
      if (objectType === 'Role') return { before: { permissions: { reports: 'READ' } }, after: { permissions: { reports: 'FULL' } }, detail: `[${MOCK_TAG}] role permissions change` };
      return { before: null, after: null, detail: `[${MOCK_TAG}] update` };
    case 'CREATE':
      return { before: null, after: { id: objectId }, detail: `[${MOCK_TAG}] ${objectType} created` };
    case 'CALIBRATE_ODOMETER':
      return { before: { odometerMi: 90000 }, after: { odometerMi: 90500 }, detail: `[${MOCK_TAG}] odometer calibration` };
    case 'LOG_EDIT_REQUESTED':
      return { before: null, after: { status: 'PENDING' }, detail: `[${MOCK_TAG}] edit request submitted` };
    case 'LOG_EDIT_ACCEPTED':
      return { before: { status: 'PENDING' }, after: { status: 'ACCEPTED' }, detail: `[${MOCK_TAG}] edit request accepted` };
    case 'LOG_EDIT_REJECTED':
      return { before: { status: 'PENDING' }, after: { status: 'REJECTED' }, detail: `[${MOCK_TAG}] edit request rejected` };
    case 'LOG_CERTIFIED':
      return { before: { certified: false }, after: { certified: true }, detail: `[${MOCK_TAG}] daily log certified` };
    case 'VIOLATION_RESOLVED':
      return { before: { status: 'OPEN' }, after: { status: 'RESOLVED' }, detail: `[${MOCK_TAG}] violation resolved` };
    case 'REVOKE':
      return { before: { revokedAt: null }, after: { revokedAt: 'now' }, detail: `[${MOCK_TAG}] revoked` };
    default:
      return { before: null, after: null, detail: `[${MOCK_TAG}] ${action}` };
  }
}

// ---------------------------------------------------------------------------
// run() — DB orchestration
// ---------------------------------------------------------------------------

export async function run(ctx: MockContext): Promise<Record<string, number>> {
  const { prisma, rng, from, to, log } = ctx;

  // ---- 1. Custom roles — id = mockId('role', key), upsert by key, NEVER delete/recreate -------
  // (B-059: a delete+recreate cycle changes the row's id every run, orphaning every AuditLog
  // row whose `actorId`/`objectId` pointed at the old one — AuditLog cannot be repaired after
  // the fact because UPDATE/DELETE on it is revoked at the DB level. Every id below is therefore
  // derived once from a stable natural key and only ever upserted.)
  const roleDefs = buildMockRoleDefs();
  await upsertAll(roleDefs, (def) =>
    prisma.role.upsert({
      where: { key: def.key },
      create: { id: mockId('role', def.key), key: def.key, name: def.name, description: def.description, isSystem: false, permissions: def.permissions as Prisma.InputJsonValue },
      update: { name: def.name, description: def.description, permissions: def.permissions as Prisma.InputJsonValue },
    }),
  );
  const allRoles = await prisma.role.findMany({ select: { id: true, key: true } });
  const roleIdByKey = new Map(allRoles.map((r) => [r.key, r.id]));
  const viewerRoleId = roleIdByKey.get('VIEWER');

  // ---- 2. Users — id = mockId('user', email), upsert by email, NEVER delete/recreate ----------
  const DEMO_PASSWORD_HASH = await hashPassword('Onebook2026');
  const userPlans = buildMockUserPlans(rng, roleDefs.map((r) => r.key), from, to);

  await upsertAll(userPlans, (p) => {
    const roleId = roleIdByKey.get(p.roleKey);
    if (!roleId) throw new Error(`users: unknown roleKey ${p.roleKey} — role must exist before user upsert.`);
    const id = mockId('user', p.email);
    const shared = {
      passwordHash: DEMO_PASSWORD_HASH,
      googleUid: p.authProvider === AuthProvider.GOOGLE ? `mock_google_${p.index}` : null,
      authProvider: p.authProvider,
      firstName: p.firstName,
      lastName: p.lastName,
      jobTitle: p.jobTitle,
      roleId,
      status: p.status,
      lastActiveAt: p.lastActiveAt,
      invitedAt: p.invitedAt,
    };
    return prisma.user.upsert({
      where: { email: p.email },
      create: { id, email: p.email, createdAt: p.createdAt, ...shared },
      update: shared,
    });
  });
  const insertedUsers = await prisma.user.findMany({
    where: { email: { endsWith: MOCK_EMAIL_DOMAIN } },
    select: { id: true, email: true, roleId: true },
    orderBy: { createdAt: 'asc' },
  });
  // invitedById back-fill: point every mock user at the first ADMIN-role mock user (self-invite
  // avoided by skipping index 0). Stable now that ids never change across re-runs.
  const firstAdminId = insertedUsers[0]?.id;
  if (firstAdminId) {
    await prisma.user.updateMany({
      where: { email: { endsWith: MOCK_EMAIL_DOMAIN }, id: { not: firstAdminId } },
      data: { invitedById: firstAdminId },
    });
  }
  const emailToId = new Map(insertedUsers.map((u) => [u.email, u.id]));
  const userIndexToId = new Map(userPlans.map((p) => [p.index, emailToId.get(p.email)!]));

  // ---- 3. Sessions — id = mockId('session', `${email}:${i}`), upsert by id --------------------
  const sessionPlans = buildMockSessionPlans(rng, userPlans, to);
  const sessionsWithIds = sessionPlans
    .map((s, planIndex) => {
      const userId = userIndexToId.get(s.userIndex);
      const email = userPlans[s.userIndex]?.email;
      if (!userId || !email) return null;
      return { id: mockId('session', `${email}:${planIndex}`), userId, plan: s };
    })
    .filter((r): r is { id: string; userId: string; plan: MockSessionPlan } => r !== null);
  await upsertAll(sessionsWithIds, ({ id, userId, plan: s }) => {
    const shared = {
      userId,
      refreshHash: sha256(`mock_refresh_${id}_${s.lastSeenAt.getTime()}`),
      userAgent: s.userAgent,
      ip: s.ip,
      deviceLabel: s.deviceLabel,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
    };
    return prisma.session.upsert({ where: { id }, create: { id, ...shared }, update: shared });
  });
  const sessionRows = sessionsWithIds;

  // ---- 4. API keys — id = mockId('apikey', `${email}:${i}`), upsert by id ---------------------
  const creatorIndices = userPlans.filter((p) => p.roleKey === 'ADMIN' || p.roleKey === 'FLEET_MANAGER').map((p) => p.index);
  const apiKeyPlans = buildMockApiKeyPlans(rng, creatorIndices.length ? creatorIndices : [userPlans[0].index], to);
  const apiKeysWithIds = apiKeyPlans
    .map((k, planIndex) => {
      const createdById = userIndexToId.get(k.creatorIndex);
      const email = userPlans[k.creatorIndex]?.email;
      if (!createdById || !email) return null;
      return { id: mockId('apikey', `${email}:${planIndex}`), createdById, plan: k };
    })
    .filter((r): r is { id: string; createdById: string; plan: MockApiKeyPlan } => r !== null);
  await upsertAll(apiKeysWithIds, ({ id, createdById, plan: k }) => {
    const plaintext = `obk_mock_${id.replace(/-/g, '').slice(0, 32)}`;
    const shared = {
      name: k.name,
      keyHash: sha256(plaintext),
      prefix: plaintext.slice(0, 8),
      scopes: k.scopes,
      createdById,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
    };
    return prisma.apiKey.upsert({ where: { id }, create: { id, ...shared }, update: shared });
  });
  const apiKeyRows = apiKeysWithIds;

  // ---- 5. Repair AuditLog rows orphaned by earlier (pre-B-059) delete+recreate runs -----------
  // AuditLog is append-only — those rows can never be UPDATEd/DELETEd, so a stale `actorId`
  // (a random uuid() from a User row that no longer exists) can never be pointed at the "real"
  // mock user again: that mapping was never recorded anywhere recoverable (see decisions.md
  // D-076, option (a) rejected). Instead every distinct stale actor id gets a minimal DISABLED
  // placeholder User row created directly on that exact id, so `GET /audit-log` actor lookups
  // resolve instead of showing an unknown/broken actor. Self-healing: once created, the
  // placeholder satisfies the FK-less lookup on every future run, so this is a no-op after once.
  // Covers both `actorId` (actorType=USER) and `objectId` (objectType='User') — same repair,
  // same table. `Role`/`ApiKey` objectId references get the analogous treatment below: this
  // class of bug (pre-B-059 delete+recreate churn changing an id after AuditLog already named
  // the old one) affected all three, not just actors (integrity check found 557 stale ApiKey
  // objectIds and 410 stale Role objectIds alongside the 60 stale User actorIds).
  if (viewerRoleId) {
    const staleUserRows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT x.id FROM (
        SELECT a."actorId" AS id FROM "AuditLog" a WHERE a."actorType" = 'USER'
        UNION
        SELECT a."objectId" AS id FROM "AuditLog" a WHERE a."objectType" = 'User'
      ) x
      WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = x.id)
    `;
    if (staleUserRows.length > 0) {
      const placeholders: Prisma.UserCreateManyInput[] = staleUserRows.map(({ id }) => ({
        id,
        email: `deleted-${id.slice(0, 8)}${MOCK_EMAIL_DOMAIN}`,
        passwordHash: null,
        authProvider: AuthProvider.PASSWORD,
        firstName: 'Deleted',
        lastName: 'mock user',
        jobTitle: null,
        roleId: viewerRoleId,
        status: UserStatus.DISABLED,
        lastActiveAt: null,
        invitedAt: null,
      }));
      const { count } = await prisma.user.createMany({ data: placeholders, skipDuplicates: true });
      log(`users: repaired ${count} orphaned AuditLog User id(s) (actor and/or object) with placeholder User rows (B-059).`);
    }

    const staleRoleIds = await prisma.$queryRaw<Array<{ objectId: string }>>`
      SELECT DISTINCT a."objectId" FROM "AuditLog" a
      WHERE a."objectType" = 'Role' AND NOT EXISTS (SELECT 1 FROM "Role" r WHERE r.id = a."objectId")
    `;
    if (staleRoleIds.length > 0) {
      const placeholderMatrix = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'NONE'])) as PermissionMatrix;
      const placeholders: Prisma.RoleCreateManyInput[] = staleRoleIds.map(({ objectId }) => ({
        id: objectId,
        key: `${MOCK_ROLE_PREFIX}DELETED_${objectId.slice(0, 8)}`,
        name: 'Deleted mock role',
        description: `[${MOCK_TAG}] placeholder for an AuditLog row whose Role no longer exists (B-059).`,
        isSystem: false,
        permissions: placeholderMatrix as Prisma.InputJsonValue,
      }));
      const { count } = await prisma.role.createMany({ data: placeholders, skipDuplicates: true });
      log(`users: repaired ${count} orphaned AuditLog Role object id(s) with placeholder Role rows (B-059).`);
    }

    const staleApiKeyIds = await prisma.$queryRaw<Array<{ objectId: string }>>`
      SELECT DISTINCT a."objectId" FROM "AuditLog" a
      WHERE a."objectType" = 'ApiKey' AND NOT EXISTS (SELECT 1 FROM "ApiKey" k WHERE k.id = a."objectId")
    `;
    if (staleApiKeyIds.length > 0 && firstAdminId) {
      const placeholders: Prisma.ApiKeyCreateManyInput[] = staleApiKeyIds.map(({ objectId }) => ({
        id: objectId,
        name: `[${MOCK_TAG}] Deleted API key`,
        keyHash: sha256(`placeholder:${objectId}`),
        prefix: objectId.slice(0, 8),
        scopes: [],
        createdById: firstAdminId,
        revokedAt: to,
      }));
      const { count } = await prisma.apiKey.createMany({ data: placeholders, skipDuplicates: true });
      log(`users: repaired ${count} orphaned AuditLog ApiKey object id(s) with placeholder ApiKey rows (B-059).`);
    }
  }

  // ---- 5b. Clean up pre-B-059 leftover Session rows ------------------------------------------
  // Session.id is never referenced by AuditLog (Session is not an audited objectType), so unlike
  // User/Role/ApiKey above, stale rows here are pure duplication (from the old delete+recreate
  // era, before Session got a stable `mockId`-derived id) with nothing to repair — safe to
  // delete outright, scoped strictly to this run's own mock users.
  {
    const keepSessionIds = sessionRows.map((s) => s.id);
    const mockUserIdsNow = insertedUsers.map((u) => u.id);
    if (mockUserIdsNow.length) {
      const { count: staleSessionCount } = await prisma.session.deleteMany({
        where: { userId: { in: mockUserIdsNow }, id: { notIn: keepSessionIds } },
      });
      if (staleSessionCount > 0) log(`users: removed ${staleSessionCount} pre-B-059 leftover Session row(s) (stable ids from here on).`);

      // ApiKey leftovers get the same cleanup, but ONLY when no AuditLog row's `objectId` still
      // points at them — unlike Session, ApiKey.id can be an audited objectId, so deleting an
      // apikey that's still referenced would recreate the exact B-059 orphan class we just
      // repaired above.
      const keepApiKeyIds = apiKeyRows.map((k) => k.id);
      const staleApiKeyCandidates = await prisma.apiKey.findMany({
        where: { createdById: { in: mockUserIdsNow }, id: { notIn: keepApiKeyIds } },
        select: { id: true },
      });
      const safeToDeleteApiKeyIds: string[] = [];
      for (const { id } of staleApiKeyCandidates) {
        const referenced = await prisma.auditLog.findFirst({ where: { objectType: 'ApiKey', objectId: id }, select: { id: true } });
        if (!referenced) safeToDeleteApiKeyIds.push(id);
      }
      if (safeToDeleteApiKeyIds.length) {
        const { count: staleApiKeyCount } = await prisma.apiKey.deleteMany({ where: { id: { in: safeToDeleteApiKeyIds } } });
        if (staleApiKeyCount > 0) log(`users: removed ${staleApiKeyCount} pre-B-059 leftover ApiKey row(s) not referenced by any AuditLog objectId.`);
      }
    }
  }

  // ---- 6. Audit log -----------------------------------------------------------
  const seedUsers = await prisma.user.findMany({ where: { email: { not: { endsWith: MOCK_EMAIL_DOMAIN } } }, select: { id: true } });
  const actorIds = [...insertedUsers.map((u) => u.id), ...seedUsers.map((u) => u.id)];

  // Sequential (not Promise.all) — keeps this generator's own connection-pool footprint low;
  // the dev DB is shared by every generator running in parallel right now.
  const mockDrivers = await prisma.driver.findMany({ where: { username: { startsWith: 'mock_' } }, select: { id: true }, take: 500 });
  const seedDrivers = await prisma.driver.findMany({ where: { username: { not: { startsWith: 'mock_' } } }, select: { id: true } });
  const mockVehicles = await prisma.vehicle.findMany({ where: { unitNumber: { startsWith: 'M1' } }, select: { id: true }, take: 500 });
  const seedVehicles = await prisma.vehicle.findMany({ where: { unitNumber: { not: { startsWith: 'M1' } } }, select: { id: true } });
  const roles = await prisma.role.findMany({ select: { id: true } });
  const apiKeyIds = await prisma.apiKey.findMany({ where: { createdById: { in: insertedUsers.map((u) => u.id) } }, select: { id: true } });

  const objectIdsByType: Record<string, string[]> = {
    User: actorIds,
    Vehicle: [...mockVehicles, ...seedVehicles].map((v) => v.id),
    Driver: [...mockDrivers, ...seedDrivers].map((d) => d.id),
    Role: roles.map((r) => r.id),
    ApiKey: apiKeyIds.map((k) => k.id),
    // EldEvent/DailyLog/HosViolation/Report/Carrier objectIds are synthetic mock-* strings —
    // hos/compliance/reports generators own those tables and had not necessarily run yet when
    // this generator ran (fixed pipeline order puts `users` second, right after `core`); using
    // a stable synthetic id keeps every audit row valid without a cross-generator dependency.
    EldEvent: [`${MOCK_TAG}_eldevent_placeholder`],
    DailyLog: [`${MOCK_TAG}_dailylog_placeholder`],
    HosViolation: [`${MOCK_TAG}_hosviolation_placeholder`],
    Report: [`${MOCK_TAG}_report_placeholder`],
    Carrier: ['carrier'],
  };

  // AuditLog is append-only at the DB level (`REVOKE UPDATE, DELETE` — tz §18) — the usual
  // "delete own mock rows, then re-insert" idempotency strategy does not apply here, and the
  // guard must never be worked around. Instead every mock audit row gets a deterministic id
  // (MOCK_AUDIT_ID_BASE + plan index, always the same for a fixed AUDIT_COUNT) and the insert
  // uses `skipDuplicates: true` on that primary key, so a re-run is a no-op for rows that
  // already exist instead of a duplicate insert. The base is far above anything the real
  // autoincrement sequence reaches in a dev DB's lifetime, so it can never collide with a
  // genuinely-written audit row.
  const AUDIT_COUNT = 4000;
  const MOCK_AUDIT_ID_BASE = 9_000_000_000n;
  const auditPlans = buildAuditPlans(rng, AUDIT_COUNT, actorIds, objectIdsByType, from, to);
  const auditRows: Prisma.AuditLogCreateManyInput[] = auditPlans.map((a, i) => ({
    id: MOCK_AUDIT_ID_BASE + BigInt(i),
    actorId: a.actorId,
    actorType: a.actorType,
    action: a.action,
    objectType: a.objectType,
    objectId: a.objectId,
    before: a.before ?? Prisma.JsonNull,
    after: a.after ?? Prisma.JsonNull,
    detail: a.detail,
    ip: a.ip,
    userAgent: a.userAgent,
    createdAt: a.createdAt,
  }));
  let auditInsertedCount = 0;
  for (let i = 0; i < auditRows.length; i += BATCH) {
    const result = await prisma.auditLog.createMany({ data: auditRows.slice(i, i + BATCH), skipDuplicates: true });
    auditInsertedCount += result.count;
  }
  log(`users: audit log — ${auditInsertedCount} new row(s) inserted, ${auditRows.length - auditInsertedCount} already present (skipped, append-only table).`);

  log(`users: ${userPlans.length} users, ${roleDefs.length} custom roles, ${sessionRows.length} sessions, ${apiKeyRows.length} api keys, ${auditRows.length} audit rows`);

  return {
    users: userPlans.length,
    customRoles: roleDefs.length,
    sessions: sessionRows.length,
    apiKeys: apiKeyRows.length,
    auditLog: auditRows.length,
  };
}
