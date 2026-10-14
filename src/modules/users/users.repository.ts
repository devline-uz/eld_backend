import { Injectable } from '@nestjs/common';
import type { Prisma, Role, User } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { emailEqualsInsensitive } from '../../common/email/email-lookup';

export type UserWithRole = User & { role: Role };

/** Lean shape for the `GET /users` list (W-18 Users table) — no `passwordHash`, no
 * `Role.permissions` blob (that's ~0.7KB of JSON duplicated per row). Full detail with the
 * role's permissions still lives on `GET /users/:id`. */
export type UserListItem = Pick<
  User,
  | 'id'
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'jobTitle'
  | 'phone'
  | 'status'
  | 'lastActiveAt'
  | 'invitedAt'
  | 'createdAt'
  | 'pendingEmail'
  | 'pendingEmailRequestedAt'
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
  // B-84 — the Users table / Edit user modal show the pending email change (Resend / Cancel).
  pendingEmail: true,
  pendingEmailRequestedAt: true,
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

  /** Trimmed, literal, case-insensitive (`emailEqualsInsensitive`) — same as `findByEmailInsensitive`. */
  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email: emailEqualsInsensitive(email) } });
  }

  /** B-84 — another account already signs in with this address (case-insensitive). */
  findByEmailInsensitive(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email: emailEqualsInsensitive(email) } });
  }

  /** B-84 — another account has an unexpired pending change to this address (requested after `since`).
   * `exceptId` omitted (invite) → any account counts. */
  async findIdByPendingEmail(email: string, since: Date, exceptId?: string): Promise<string | null> {
    const row = await this.prisma.user.findFirst({
      where: {
        ...(exceptId ? { id: { not: exceptId } } : {}),
        pendingEmail: emailEqualsInsensitive(email),
        pendingEmailRequestedAt: { gt: since },
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** B-84 — compare-and-set: writes `data` only while the row still matches `expect` (a newer
   * request, a cancel or a parallel click has not moved it on). True when the write happened. */
  async updateIfState(id: string, expect: Prisma.UserWhereInput, data: Prisma.UserUpdateManyMutationInput): Promise<boolean> {
    const res = await this.prisma.user.updateMany({ where: { id, ...expect }, data });
    return res.count > 0;
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
