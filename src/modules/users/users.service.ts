import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { AttachmentsService } from '../attachments/attachments.service';
import { AuthService } from '../auth/auth.service';
import { RolesRepository } from '../roles/roles.repository';
import { readImageDimensions, stripImageMetadata } from './lib/image-dimensions.util';
import { CreateUserDto, PreferencesDto, UpdateMyProfileDto, UpdateUserDto } from './dto/users.dto';
import { UserListItem, UsersRepository, UserWithRole } from './users.repository';

export type UserView = Omit<UserWithRole, 'passwordHash'> & { avatarUrl?: string | null };

/** Never let a password hash leave this module (TZ §6.5). */
function toView(user: UserWithRole): Omit<UserWithRole, 'passwordHash'> {
  const { passwordHash: _p, ...view } = user;
  return view;
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
  async invite(dto: CreateUserDto, invitedById: string): Promise<{ user: UserView; inviteToken?: string }> {
    const role = await this.roles.findById({ id: dto.roleId });
    if (!role) throw AppException.notFound('Role not found.');
    const existing = await this.users.findByEmail(dto.email);
    if (existing) throw AppException.conflict(`A user with email "${dto.email}" already exists.`);

    const user = await this.users.create({
      email: dto.email,
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
    const withRole = { ...user, role };
    const inviteToken = this.auth.issueResetToken(user.id, null);
    if (dto.message) {
      // B-85 — no outbound-mail transport exists yet (same Phase-1 gap as
      // `AuthService.forgotPassword`); the message is logged so it is at least
      // observable/testable until a mailer is wired.
      this.logger.log({ userId: user.id, email: user.email, message: dto.message }, 'Invite message (no mailer wired in Phase 1)');
    }
    return { user: toView(withRole), inviteToken };
  }

  /** `@Audit({ object: 'User', action: 'INVITE' })` on the controller — a resend is still an invite. */
  async resendInvite(id: string): Promise<{ inviteToken?: string }> {
    const user = await this.getRaw(id);
    // Restarts the invite window `AuthService.loginGoogle` checks against `invitedAt`.
    if (user.status === 'INVITED') await this.users.update({ id }, { invitedAt: new Date() });
    return { inviteToken: this.auth.issueResetToken(user.id, user.passwordHash) };
  }

  /**
   * `@Audit` on the controller picks `ROLE_CHANGE` vs `UPDATE` — this method just applies
   * the diff; role-immutability (ADMIN `isSystem`) is a *role* rule (`RolesService`), not a
   * *user* rule, so any role can be assigned here as long as it exists.
   */
  /**
   * B-84 — `email` is deliberately NOT written here: `AuthService.verifyEmailChange` is the
   * only path that writes `User.email`, so a changed address always goes through
   * re-verification. `emailVerification` on the return value carries the token the same way
   * `invite()`/`forgotPassword()` do (outside production only — no mailer in Phase 1).
   */
  async update(id: string, dto: UpdateUserDto): Promise<UserView & { emailVerification?: { pendingEmail: string; verifyToken?: string } }> {
    const current = await this.getRaw(id);
    let nextRoleKey = current.role.key;
    if (dto.roleId) {
      const role = await this.roles.findById({ id: dto.roleId });
      if (!role) throw AppException.notFound('Role not found.');
      nextRoleKey = role.key;
    }
    // The web panel refuses to demote or disable the last active ADMIN (it would lock every user
    // out of Settings); the server enforces the same rule so a stale tab or a direct call can't.
    const losesAdmin = nextRoleKey !== 'ADMIN' || (dto.status !== undefined && dto.status !== 'ACTIVE');
    if (current.role.key === 'ADMIN' && current.status === 'ACTIVE' && losesAdmin) {
      const activeAdmins = await this.users.countActiveAdmins();
      if (activeAdmins <= 1) {
        throw AppException.conflict('This is the last active admin. Promote another user to Admin first.');
      }
    }
    let emailVerification: { pendingEmail: string; verifyToken?: string } | undefined;
    if (dto.email !== undefined && dto.email !== current.email) {
      const existing = await this.users.findByEmail(dto.email);
      if (existing && existing.id !== id) {
        throw AppException.conflict(`A user with email "${dto.email}" already exists.`);
      }
      const verifyToken = this.auth.issueUserEmailVerifyToken(id, dto.email);
      emailVerification = { pendingEmail: dto.email, verifyToken };
      this.logger.log({ userId: id, pendingEmail: dto.email }, 'Email change re-verification requested (no mailer wired in Phase 1)');
    }
    await this.users.update(
      { id },
      {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.jobTitle !== undefined && { jobTitle: dto.jobTitle }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.roleId !== undefined && { role: { connect: { id: dto.roleId } } }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.homeTerminalName !== undefined && { homeTerminalName: dto.homeTerminalName }),
      },
    );
    const view = await this.get(id);
    return emailVerification ? { ...view, emailVerification } : view;
  }

  async remove(id: string): Promise<void> {
    await this.getRaw(id);
    await this.users.delete({ id });
  }

  async updateMyProfile(id: string, dto: UpdateMyProfileDto): Promise<UserView> {
    await this.users.update({ id }, { ...dto });
    return this.get(id);
  }

  isRoleChange(dto: UpdateUserDto): boolean {
    return dto.roleId !== undefined;
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
