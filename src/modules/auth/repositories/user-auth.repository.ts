import { Injectable } from '@nestjs/common';
import type { Role, User } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

export type UserWithRole = User & { role: Role };

/** TZ §3.5 — the only place `prisma.user` is touched for auth flows. */
@Injectable()
export class UserAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmailWithRole(email: string): Promise<UserWithRole | null> {
    return this.prisma.user.findUnique({ where: { email }, include: { role: true } });
  }

  findByIdWithRole(id: string): Promise<UserWithRole | null> {
    return this.prisma.user.findUnique({ where: { id }, include: { role: true } });
  }

  setGoogleUid(id: string, googleUid: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { googleUid } });
  }

  touchLastActive(id: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { lastActiveAt: new Date() } });
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /** B-84 — applies a re-verified email change. `googleUid` is cleared: the old Google
   * identity was bound to the previous address and must not silently authenticate the new
   * one (TZ §6.2 — no auto-registration/identity-hijack path). */
  applyVerifiedEmail(id: string, email: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { email, googleUid: null } });
  }
}
