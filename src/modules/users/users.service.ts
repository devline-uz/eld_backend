import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AUDIT_EVENT, type AuditEventPayload } from '../../common/interceptors/audit.interceptor';
import { RequestContext } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AppConfigService } from '../../core/config/config.service';
import { TRANSACTIONAL_MAIL, TransactionalMailPort } from '../../core/mail/mail.port';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuthService, INVITE_TTL_MS } from '../auth/auth.service';
import { PrincipalStateService } from '../auth/principal-state.service';
import {
  assertWithinCeiling,
  CeilingActor,
  exceedingPermissions,
  levelsOf,
  PermissionCeiling,
  resolveCeiling,
} from '../roles/permission-ceiling';
import { RolesRepository } from '../roles/roles.repository';
import { readImageDimensions, stripImageMetadata } from './lib/image-dimensions.util';
import { buildInviteEmail } from './lib/invite-email';
import { CreateUserDto, PreferencesDto, UpdateMyProfileDto, UpdateUserDto } from './dto/users.dto';
import {
  emailTakenConflict,
  isUniqueViolation,
  normalizeUserEmail,
  UserEmailChangeService,
  type UserEmailVerificationView,
} from './user-email-change.service';
import { UserListItem, UsersRepository, UserWithRole } from './users.repository';

/** The authenticated caller, as passed from the controller (`@CurrentUser()`). */
export interface Actor extends CeilingActor {
  id: string;
  role?: string;
}

export const SUPER_ADMIN_KEY = 'SUPER_ADMIN';
/** Roles that only a SUPER_ADMIN may assign, hold-edit, disable or delete. */
export const PRIVILEGED_ROLE_KEYS: readonly string[] = ['ADMIN', SUPER_ADMIN_KEY];
export const isPrivilegedRole = (key: string | undefined): boolean => !!key && PRIVILEGED_ROLE_KEYS.includes(key);

function assertSuperAdmin(actor: Actor | undefined): void {
  if (actor?.role !== SUPER_ADMIN_KEY) throw AppException.forbidden('Only a Super Admin can manage administrators.');
}

export type { UserEmailVerificationView } from './user-email-change.service';

/** Fields that never leave this module: the password hash (TZ §6.5), the Google account id the
 * user is bound to and the lockout bookkeeping (CODE-087 / CODE-082) — the UI only needs to know
 * whether a Google account is linked. */
type HiddenUserField = 'passwordHash' | 'googleUid' | 'failedLoginCount' | 'lockedUntil';
export type UserView = Omit<UserWithRole, HiddenUserField> & { googleLinked: boolean; avatarUrl?: string | null };

function toView(user: UserWithRole): Omit<UserView, 'avatarUrl'> {
  const { passwordHash: _p, googleUid, failedLoginCount: _f, lockedUntil: _l, ...view } = user;
  return { ...view, googleLinked: Boolean(googleUid) };
}

/** B-51 accepts PNG/JPG; a generous 5 MB cap keeps a "photo" upload from becoming a DoS vector. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_MIN_DIMENSION = 256;
/** B-095 — a 5 MB PNG can still declare 65535x65535 px (a decompression bomb for every
 * browser that renders the avatar); anything above this is refused. */
const AVATAR_MAX_DIMENSION = 8192;

interface UploadedAvatarFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * TZ §11.7 — back-office user CRUD, the piece that makes role assignment (modules/roles)
 * actually usable. Invite issuance reuses `AuthService`'s password-reset token machinery
 * (TZ §6.5) rather than duplicating it — an invited user's `passwordHash` is null, and
 * `issueResetToken` binds the token to whatever hash currently exists (null included).
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly roles: RolesRepository,
    private readonly auth: AuthService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly attachments: AttachmentsService,
    @Inject(TRANSACTIONAL_MAIL) private readonly mail: TransactionalMailPort,
    private readonly config: AppConfigService,
    private readonly emailChange: UserEmailChangeService,
    private readonly principals: PrincipalStateService,
    @Optional() private readonly events?: EventBusService,
  ) {}

  /** W-18 Users table — trimmed payload (TZ perf plan item 2): no `passwordHash`, no
   * `Role.permissions` blob. Full detail (incl. role permissions) is `GET /users/:id`. */
  async list(): Promise<UserListItem[]> {
    return this.users.listWithRoles();
  }

  async get(id: string): Promise<UserView> {
    const user = await this.users.findByIdWithRole(id);
    if (!user) throw AppException.notFound('User not found.');
    const view: UserView = toView(user);
    if (user.avatarKey) {
      // B-51 — reuses the reusable presign helper (`AttachmentsService.presignKey`, §20 B-41)
      // rather than reaching for `STORAGE_PORT.presignGet` directly.
      view.avatarUrl = (await this.attachments.presignKey(user.avatarKey)).url;
    }
    return view;
  }

  private async getRaw(id: string): Promise<UserWithRole> {
    const user = await this.users.findByIdWithRole(id);
    if (!user) throw AppException.notFound('User not found.');
    return user;
  }

  /** `@Audit({ object: 'User', action: 'INVITE' })` lives on the controller (TZ §18). */
  async invite(
    dto: CreateUserDto,
    actor: Actor,
  ): Promise<{ user: UserView; emailDelivered: boolean; inviteToken?: string }> {
    const invitedById = actor.id;
    const role = await this.roles.findById({ id: dto.roleId });
    if (!role) throw AppException.notFound('Role not found.');
    if (isPrivilegedRole(role.key)) assertSuperAdmin(actor);
    const ceiling = await resolveCeiling(actor, this.roles);
    assertWithinCeiling(levelsOf(role.permissions), ceiling, 'You cannot assign a role with permissions above your own');
    // Stored trimmed + lower-case (`User.email` is unique on `lower(email)`), compared case-insensitively.
    // A pending invite is a `User` row in INVITED status, so `assertAvailable` covers it too, as well
    // as another account's unexpired pending email change (same 409 EMAIL_TAKEN as `PATCH /users/:id`).
    const email = normalizeUserEmail(dto.email);
    await this.emailChange.assertAvailable(email);

    let user: Awaited<ReturnType<UsersRepository['create']>>;
    try {
      user = await this.users.create({
        email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        jobTitle: dto.jobTitle,
        phone: dto.phone,
        role: { connect: { id: dto.roleId } },
        invitedById,
        invitedAt: new Date(),
        // B-85 — terminal scope: stored, not yet enforced (D-090, tz.md §20.4 question 2 open).
        terminalScope: dto.terminalIds ?? [],
      });
    } catch (err) {
      // A concurrent invite / email confirm took the address between the check and the insert.
      if (isUniqueViolation(err)) throw emailTakenConflict();
      throw err;
    }
    const withRole = { ...user, role };
    const emailDelivered = await this.sendInviteEmail(withRole, dto.message);
    return { user: toView(withRole), emailDelivered, ...this.echoInviteToken(withRole) };
  }

  /** `@Audit({ object: 'User', action: 'INVITE' })` on the controller — a resend is still an invite. */
  async resendInvite(id: string, actor: Actor): Promise<{ emailDelivered: boolean; inviteToken?: string }> {
    const user = await this.getRaw(id);
    if (isPrivilegedRole(user.role.key)) assertSuperAdmin(actor);
    if (user.status !== 'INVITED') throw AppException.conflict('User is not in INVITED status.');
    // Restarts the invite window `AuthService.loginGoogle` checks against `invitedAt`.
    const invitedAt = new Date();
    await this.users.update({ id }, { invitedAt });
    const emailDelivered = await this.sendInviteEmail({ ...user, invitedAt });
    return { emailDelivered, ...this.echoInviteToken(user) };
  }

  /** Best effort: the user exists either way, so a mail failure is reported, not thrown. */
  private async sendInviteEmail(user: UserWithRole, message?: string): Promise<boolean> {
    const inviter = user.invitedById
      ? await this.users.findByIdWithRole(user.invitedById).catch(() => null)
      : null;
    const result = await this.mail.send(
      buildInviteEmail({
        to: user.email,
        firstName: user.firstName,
        roleName: user.role.name,
        inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : undefined,
        message,
        signInUrl: new URL('/sign-in', this.config.get('WEB_APP_URL')).toString(),
        expiresAt: new Date((user.invitedAt ?? new Date()).getTime() + INVITE_TTL_MS),
      }),
    );
    if (!result.delivered) {
      this.logger.warn({ userId: user.id, reason: result.reference }, 'Invite email was not delivered');
    }
    return result.delivered;
  }

  /** The invite token is a password-reset token — echoed only where one-time secrets may be
   * (B-093), never on a shared host. Invites are accepted through Google sign-in. */
  private echoInviteToken(user: UserWithRole): { inviteToken?: string } {
    return this.config.echoOneTimeSecrets
      ? { inviteToken: this.auth.issueResetToken(user.id, user.passwordHash) }
      : {};
  }

  /**
   * `@Audit` on the controller records the field diff as `UPDATE`; a role change additionally
   * gets its own `ROLE_CHANGE` row from here (CODE-083). Role-immutability (ADMIN `isSystem`) is a
   * *role* rule (`RolesService`), not a *user* rule. CODE-002: a non-SUPER_ADMIN may only assign a
   * role within their own levels.
   */
  /**
   * B-84 — `email` is never written here: a changed address (trim + lower-case, compared
   * case-insensitively) becomes a pending change (`UserEmailChangeService`) that needs the ACTING
   * user's re-authentication (`currentPassword` / `reauthIdToken`) and the new owner's confirmation
   * (`POST /auth/email/verify`). A newer request replaces the pending one and kills its links.
   * The old address is told, with a cancel / revert link. An unchanged email is a no-op.
   */
  async update(id: string, dto: UpdateUserDto, actor: Actor): Promise<UserView & { emailVerification?: UserEmailVerificationView }> {
    const current = await this.getRaw(id);
    let nextRoleKey = current.role.key;
    let nextRole: { permissions: unknown } | undefined;
    if (dto.roleId) {
      const role = await this.roles.findById({ id: dto.roleId });
      if (!role) throw AppException.notFound('Role not found.');
      nextRoleKey = role.key;
      nextRole = role;
    }
    // Only a SUPER_ADMIN may touch a privileged user, or move anyone to/from a privileged role.
    if (isPrivilegedRole(current.role.key) || isPrivilegedRole(nextRoleKey)) assertSuperAdmin(actor);
    // CODE-002 — no self role/status change, no managing a user above you, no assigning a role above you.
    const ceiling = await resolveCeiling(actor, this.roles);
    if (!ceiling.unrestricted) {
      const changesRole = dto.roleId !== undefined && dto.roleId !== current.role.id;
      const changesStatus = dto.status !== undefined && dto.status !== current.status;
      if (id === actor.id && (changesRole || changesStatus)) {
        throw AppException.forbidden('You cannot change your own role or status.');
      }
      this.assertCanManage(current, ceiling);
      if (nextRole && changesRole) {
        assertWithinCeiling(levelsOf(nextRole.permissions), ceiling, 'You cannot assign a role with permissions above your own');
      }
    }
    // CODE-087 — an invite is accepted only by its owner's first Google sign-in (`AuthService.loginGoogle`);
    // flipping it to ACTIVE here would create a usable account nobody ever claimed. That includes an
    // invite that was disabled and is now "enabled" again: never signed in, no password, no Google link.
    const neverAccepted = !current.passwordHash && !current.googleUid && !current.lastActiveAt;
    if (dto.status === 'ACTIVE' && current.status !== 'ACTIVE' && (current.status === 'INVITED' || neverAccepted)) {
      throw AppException.conflict('This invitation has not been accepted yet. The user becomes active on their first sign-in.');
    }
    // Never leave the system without an active SUPER_ADMIN (nor without any active administrator):
    // the server enforces it so a stale tab or a direct call can't lock every user out of Settings.
    const losesStatus = dto.status !== undefined && dto.status !== 'ACTIVE';
    await this.assertNotLastAdmin(current, nextRoleKey, losesStatus);
    const requested = dto.email !== undefined ? normalizeUserEmail(dto.email) : undefined;
    const newEmail = requested !== undefined && requested !== current.email.toLowerCase() ? requested : undefined;
    if (newEmail) {
      // Availability first (a taken address is reported before any password is asked for), then the
      // hold of the previous change and the acting user's re-authentication.
      await this.emailChange.assertAvailable(newEmail, id);
      await this.emailChange.assertRequestable(current, actor.id, {
        currentPassword: dto.currentPassword,
        reauthIdToken: dto.reauthIdToken,
      });
    }
    const updated = await this.users.update(
      { id },
      {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.jobTitle !== undefined && { jobTitle: dto.jobTitle }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.roleId !== undefined && { role: { connect: { id: dto.roleId } } }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.homeTerminalName !== undefined && { homeTerminalName: dto.homeTerminalName }),
        ...(newEmail ? this.emailChange.pendingInput(newEmail, actor.id, new Date()) : {}),
      },
    );
    // CODE-012 — access must end/shrink now, not when the 15-minute access token expires.
    const statusChanged = dto.status !== undefined && dto.status !== current.status;
    const roleChanged = dto.roleId !== undefined && dto.roleId !== current.role.id;
    if (statusChanged && dto.status !== 'ACTIVE') await this.auth.revokeAllUserSessions(id);
    if (statusChanged || roleChanged) await this.principals.invalidateUser(id);
    // CODE-083 — a role change is a privilege change: its own audit row (the route's generic
    // `UPDATE` row still records the field diff), naming the old and new role.
    if (roleChanged && nextRole) {
      this.auditRoleChange(id, actor, { roleId: current.role.id, roleKey: current.role.key }, { roleId: dto.roleId, roleKey: nextRoleKey });
    }
    const emailVerification = newEmail ? await this.emailChange.notifyRequested(updated, current) : undefined;
    const view = await this.get(id);
    return emailVerification ? { ...view, emailVerification } : view;
  }

  /** `POST /users/:id/email-change/resend` — same privileged-target rule as `PATCH`. */
  async resendEmailChange(id: string, actor: Actor) {
    const current = await this.getRaw(id);
    if (isPrivilegedRole(current.role.key)) assertSuperAdmin(actor);
    return this.emailChange.resend(id);
  }

  /** `DELETE /users/:id/email-change` — same privileged-target rule as `PATCH`. */
  async cancelEmailChange(id: string, actor: Actor): Promise<UserView> {
    const current = await this.getRaw(id);
    if (isPrivilegedRole(current.role.key)) assertSuperAdmin(actor);
    await this.emailChange.cancelPending(id);
    return this.get(id);
  }

  /** 409 when the change would remove the last active SUPER_ADMIN, or the last active ADMIN/SUPER_ADMIN. */
  private async assertNotLastAdmin(current: UserWithRole, nextRoleKey: string | null, losesStatus: boolean): Promise<void> {
    if (current.status !== 'ACTIVE') return;
    if (current.role.key === SUPER_ADMIN_KEY && (nextRoleKey !== SUPER_ADMIN_KEY || losesStatus)) {
      if ((await this.users.countActiveSuperAdmins()) <= 1) {
        throw AppException.conflict('This is the last active Super Admin. Promote another user to Super Admin first.');
      }
    }
    if (isPrivilegedRole(current.role.key) && (!isPrivilegedRole(nextRoleKey ?? undefined) || losesStatus)) {
      if ((await this.users.countActiveAdmins()) <= 1) {
        throw AppException.conflict('This is the last active admin. Promote another user to Admin first.');
      }
    }
  }

  /** CODE-002 — a non-SUPER_ADMIN cannot act on a user whose role has permissions above their own. */
  private assertCanManage(target: UserWithRole, ceiling: PermissionCeiling): void {
    if (exceedingPermissions(levelsOf(target.role.permissions), ceiling).length > 0) {
      throw AppException.forbidden('You cannot manage a user whose role has permissions above your own.');
    }
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const current = await this.getRaw(id);
    if (isPrivilegedRole(current.role.key)) assertSuperAdmin(actor);
    const ceiling = await resolveCeiling(actor, this.roles);
    if (!ceiling.unrestricted) {
      if (id === actor.id) throw AppException.forbidden('You cannot delete your own account.');
      this.assertCanManage(current, ceiling);
    }
    await this.assertNotLastAdmin(current, null, true);
    // CODE-014 — reports and API keys keep their author (FK RESTRICT); deleting would 500. The
    // history must stay attributable, so the answer is 409 with the way out: disable the user.
    const blockers = await this.users.countDeleteBlockers(id);
    if (blockers.reports > 0 || blockers.apiKeys > 0) {
      const parts = [
        blockers.reports > 0 && `${blockers.reports} report(s)`,
        blockers.apiKeys > 0 && `${blockers.apiKeys} API key(s)`,
      ].filter(Boolean);
      throw AppException.conflict(
        `This user is the author of ${parts.join(' and ')} and cannot be deleted. Disable the user instead.`,
        { reasons: blockers },
      );
    }
    await this.users.delete({ id });
    await this.principals.invalidateUser(id);
  }

  async updateMyProfile(id: string, dto: UpdateMyProfileDto): Promise<UserView> {
    await this.users.update({ id }, { ...dto });
    return this.get(id);
  }

  private auditRoleChange(
    userId: string,
    actor: Actor,
    before: { roleId: string; roleKey: string },
    after: { roleId: string | undefined; roleKey: string },
  ): void {
    const rc = RequestContext.get();
    const payload: AuditEventPayload = {
      actorId: actor.id,
      actorType: rc?.user?.type ?? 'user',
      action: 'ROLE_CHANGE',
      objectType: 'User',
      objectId: userId,
      before,
      after,
      ip: rc?.ip,
      userAgent: rc?.userAgent,
      traceId: rc?.traceId,
    };
    void this.events?.publish(AUDIT_EVENT, payload);
  }

  // ---------------------------------------------------------------------
  // B-51 — avatar upload/delete
  // ---------------------------------------------------------------------

  async uploadAvatar(id: string, file: UploadedAvatarFile | undefined): Promise<UserView> {
    if (!file) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'No file was uploaded.', 400);
    if (file.size > AVATAR_MAX_BYTES) {
      throw new AppException(ERROR_CODES.FILE_TOO_LARGE, `Avatar must be under ${AVATAR_MAX_BYTES / 1024 / 1024} MB.`, 422);
    }
    const dims = readImageDimensions(file.buffer);
    if (!dims || (dims.format === 'png' && file.mimetype !== 'image/png') || (dims.format === 'jpeg' && file.mimetype !== 'image/jpeg')) {
      throw new AppException(ERROR_CODES.UNSUPPORTED_FILE_TYPE, 'Avatar must be a PNG or JPG image.', 422);
    }
    if (dims.width < AVATAR_MIN_DIMENSION || dims.height < AVATAR_MIN_DIMENSION) {
      throw new AppException(
        ERROR_CODES.IMAGE_TOO_SMALL,
        `Avatar must be at least ${AVATAR_MIN_DIMENSION}x${AVATAR_MIN_DIMENSION}px (got ${dims.width}x${dims.height}).`,
        422,
      );
    }

    if (dims.width > AVATAR_MAX_DIMENSION || dims.height > AVATAR_MAX_DIMENSION) {
      throw new AppException(
        ERROR_CODES.UNSUPPORTED_FILE_TYPE,
        `Avatar must be at most ${AVATAR_MAX_DIMENSION}x${AVATAR_MAX_DIMENSION}px (got ${dims.width}x${dims.height}).`,
        422,
      );
    }
    const stripped = stripImageMetadata(file.buffer, dims.format);
    if (!stripped) throw new AppException(ERROR_CODES.UNSUPPORTED_FILE_TYPE, 'Avatar must be a PNG or JPG image.', 422);

    const current = await this.getRaw(id);
    const ext = dims.format === 'png' ? 'png' : 'jpg';
    const key = `avatars/${id}/${randomUUID()}.${ext}`;
    await this.storage.put(key, stripped, { contentType: file.mimetype });
    await this.users.update({ id }, { avatarKey: key });
    if (current.avatarKey) {
      // Best-effort cleanup of the previous object — never lets a delete failure block the
      // upload that already succeeded and was already persisted.
      await this.storage.delete(current.avatarKey).catch(() => undefined);
    }
    return this.get(id);
  }

  async deleteAvatar(id: string): Promise<UserView> {
    const current = await this.getRaw(id);
    if (current.avatarKey) {
      await this.storage.delete(current.avatarKey).catch(() => undefined);
      await this.users.update({ id }, { avatarKey: null });
    }
    return this.get(id);
  }

  // ---------------------------------------------------------------------
  // B-11 — `GET/PUT /me/preferences`
  // ---------------------------------------------------------------------

  async getPreferences(id: string): Promise<PreferencesDto> {
    const user = await this.getRaw(id);
    return (user.preferences as PreferencesDto | null) ?? {};
  }

  async updatePreferences(id: string, dto: PreferencesDto): Promise<PreferencesDto> {
    await this.getRaw(id);
    // Prisma's `Json` input type wants `InputJsonValue`, not our structurally-typed
    // `PreferencesDto` — this DTO is already zod-validated plain JSON by the time it gets here.
    await this.users.update({ id }, { preferences: dto as Prisma.InputJsonValue });
    return dto;
  }
}
