import { Injectable } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { CreateRoleDto, UpdateRoleDto } from './dto/roles.dto';
import { RolesRepository } from './roles.repository';

/**
 * TZ §6.4 — 22-key permission matrix as data, read by `PermissionGuard` via the `per`
 * token claim (issued at login by `modules/auth`) and authored here.
 * `ADMIN` is `isSystem = true` — TZ §6.4 "o'chirib yoki tahrirlab bo'lmaydi".
 */
@Injectable()
export class RolesService {
  constructor(private readonly roles: RolesRepository) {}

  /** Each role carries `userCount` so the web Roles screen can show "N users assigned". */
  async list(): Promise<Array<Role & { userCount: number }>> {
    const [roles, counts] = await Promise.all([
      this.roles.findMany(undefined, undefined, { name: 'asc' }),
      this.roles.userCountsByRole(),
    ]);
    return roles.map((role) => ({ ...role, userCount: counts.get(role.id) ?? 0 }));
  }

  async get(id: string): Promise<Role> {
    const role = await this.roles.findById({ id });
    if (!role) throw AppException.notFound('Role not found.');
    return role;
  }

  async create(dto: CreateRoleDto): Promise<Role> {
    const existing = await this.roles.findByKey(dto.key);
    if (existing) throw AppException.conflict(`Role key "${dto.key}" already exists.`);
    return this.roles.create({
      key: dto.key,
      name: dto.name,
      description: dto.description,
      permissions: dto.permissions,
      isSystem: false,
    });
  }

  async update(id: string, dto: UpdateRoleDto, actor?: { role?: string }): Promise<Role> {
    const role = await this.get(id);
    if (role.key === 'SUPER_ADMIN') this.assertNotSystem(role);
    if (role.key === 'ADMIN' && actor?.role !== 'SUPER_ADMIN') {
      throw AppException.forbidden('Only a Super Admin can manage administrators.');
    }
    if (role.key !== 'ADMIN') this.assertNotSystem(role);
    return this.roles.update(
      { id },
      {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.permissions !== undefined && { permissions: dto.permissions }),
      },
    );
  }

  async remove(id: string): Promise<void> {
    const role = await this.get(id);
    this.assertNotSystem(role);
    const usersWithRole = await this.roles.countUsersWithRole(id);
    if (usersWithRole > 0) {
      throw AppException.conflict(`Role is still assigned to ${usersWithRole} user(s).`);
    }
    await this.roles.delete({ id });
  }

  private assertNotSystem(role: Role): void {
    if (role.isSystem) {
      throw new AppException(ERROR_CODES.ROLE_IMMUTABLE, `"${role.key}" is a system role and cannot be modified.`, 403);
    }
  }
}
