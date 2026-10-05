import { Injectable } from '@nestjs/common';
import type { Prisma, Role, User } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

export type UserWithRole = User & { role: Role };

/** Lean shape for the `GET /users` list (W-18 Users table) — no `passwordHash`, no
 * `Role.permissions` blob (that's ~0.7KB of JSON duplicated per row). Full detail with the
 * role's permissions still lives on `GET /users/:id`. */
export type UserListItem = Pick<
  User,
  'id' | 'email' | 'firstName' | 'lastName' | 'jobTitle' | 'phone' | 'status' | 'lastActiveAt' | 'invitedAt' | 'createdAt'
> & { role: Pick<Role, 'id' | 'key' | 'name'> };

const LIST_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  jobTitle: true,
  phone: true,
  status: true,
  lastActiveAt: true,
  invitedAt: true,
  createdAt: true,
  role: { select: { id: true, key: true, name: true } },
} as const;

@Injectable()
export class UsersRepository extends BaseRepository<
  User,
  Prisma.UserWhereInput,
  Prisma.UserWhereUniqueInput,
  Prisma.UserCreateInput,
  Prisma.UserUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    User,
    Prisma.UserWhereInput,
    Prisma.UserWhereUniqueInput,
    Prisma.UserCreateInput,
    Prisma.UserUpdateInput
  > {
    return this.prisma.user;
  }

  listWithRoles(): Promise<UserListItem[]> {
    return this.prisma.user.findMany({ select: LIST_SELECT, orderBy: { createdAt: 'desc' } });
  }

  findByIdWithRole(id: string): Promise<UserWithRole | null> {
    return this.prisma.user.findUnique({ where: { id }, include: { role: true } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /** Active users holding a privileged role (ADMIN or SUPER_ADMIN) — the last-admin guard. */
  countActiveAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { status: 'ACTIVE', role: { key: { in: ['ADMIN', 'SUPER_ADMIN'] } } } });
  }

  /** Active SUPER_ADMIN users — the system must never be left without one. */
  countActiveSuperAdmins(): Promise<number> {
    return this.prisma.user.count({ where: { status: 'ACTIVE', role: { key: 'SUPER_ADMIN' } } });
  }
}
