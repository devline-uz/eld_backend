import { Injectable } from '@nestjs/common';
import type { Prisma, Role } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

@Injectable()
export class RolesRepository extends BaseRepository<
  Role,
  Prisma.RoleWhereInput,
  Prisma.RoleWhereUniqueInput,
  Prisma.RoleCreateInput,
  Prisma.RoleUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Role,
    Prisma.RoleWhereInput,
    Prisma.RoleWhereUniqueInput,
    Prisma.RoleCreateInput,
    Prisma.RoleUpdateInput
  > {
    return this.prisma.role;
  }

  findByKey(key: string): Promise<Role | null> {
    return this.prisma.role.findUnique({ where: { key } });
  }

  /** roleId → number of back-office users holding it (web W-21 "N users assigned"). */
  async userCountsByRole(): Promise<Map<string, number>> {
    const rows = await this.prisma.user.groupBy({ by: ['roleId'], _count: { _all: true } });
    return new Map(rows.map((r) => [r.roleId, r._count._all]));
  }

  /** CODE-002 — the role a back-office user holds *now* (null if missing or not ACTIVE), so
   * permission ceilings never trust a stale token claim. */
  async findRoleOfUser(userId: string): Promise<Role | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true, role: true } });
    return user?.status === 'ACTIVE' ? user.role : null;
  }

  countUsersWithRole(roleId: string): Promise<number> {
    return this.prisma.user.count({ where: { roleId } });
  }
}
