import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { AuthService } from '../auth/auth.service';
import { RolesRepository } from '../roles/roles.repository';
import { CreateUserDto, UpdateMyProfileDto, UpdateUserDto } from './dto/users.dto';
import { UsersRepository, UserWithRole } from './users.repository';

export type UserView = Omit<UserWithRole, 'passwordHash'>;

/** Never let a password hash leave this module (TZ §6.5). */
function toView(user: UserWithRole): UserView {
  const { passwordHash: _p, ...view } = user;
  return view;
}

/**
 * TZ §11.7 — back-office user CRUD, the piece that makes role assignment (modules/roles)
 * actually usable. Invite issuance reuses `AuthService`'s password-reset token machinery
 * (TZ §6.5) rather than duplicating it — an invited user's `passwordHash` is null, and
 * `issueResetToken` binds the token to whatever hash currently exists (null included).
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly users: UsersRepository,
    private readonly roles: RolesRepository,
    private readonly auth: AuthService,
  ) {}

  async list(): Promise<UserView[]> {
    return (await this.users.listWithRoles()).map(toView);
  }

  async get(id: string): Promise<UserView> {
    const user = await this.users.findByIdWithRole(id);
    if (!user) throw AppException.notFound('User not found.');
    return toView(user);
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
    });
    const withRole = { ...user, role };
    const inviteToken = this.auth.issueResetToken(user.id, null);
    return { user: toView(withRole), inviteToken };
  }

  /** `@Audit({ object: 'User', action: 'INVITE' })` on the controller — a resend is still an invite. */
  async resendInvite(id: string): Promise<{ inviteToken?: string }> {
    const user = await this.getRaw(id);
    return { inviteToken: this.auth.issueResetToken(user.id, user.passwordHash) };
  }

  /**
   * `@Audit` on the controller picks `ROLE_CHANGE` vs `UPDATE` — this method just applies
   * the diff; role-immutability (ADMIN `isSystem`) is a *role* rule (`RolesService`), not a
   * *user* rule, so any role can be assigned here as long as it exists.
   */
  async update(id: string, dto: UpdateUserDto): Promise<UserView> {
    await this.getRaw(id);
    if (dto.roleId) {
      const role = await this.roles.findById({ id: dto.roleId });
      if (!role) throw AppException.notFound('Role not found.');
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
      },
    );
    return this.get(id);
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
}
