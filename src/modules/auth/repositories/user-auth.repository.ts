import { Injectable } from '@nestjs/common';
import type { Role, User } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';
import { emailEqualsInsensitive } from '../../../common/email/email-lookup';

export type UserWithRole = User & { role: Role };

/** TZ §3.5 — the only place `prisma.user` is touched for auth flows. */
@Injectable()
export class UserAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Password login, Google sign-in / invite acceptance, forgot-password and reset-code: the address
   * as typed (or as Google returns it) may differ in case / surrounding spaces from the stored one,
   * and pre-normalization rows may be mixed-case — trimmed, literal, case-insensitive match. */
  findByEmailWithRole(email: string): Promise<UserWithRole | null> {
    return this.prisma.user.findFirst({ where: { email: emailEqualsInsensitive(email) }, include: { role: true } });
  }

  findByIdWithRole(id: string): Promise<UserWithRole | null> {
    return this.prisma.user.findUnique({ where: { id }, include: { role: true } });
  }

  setGoogleUid(id: string, googleUid: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { googleUid } });
  }

  /** Invite acceptance — `INVITED` → `ACTIVE` on the first Google sign-in (`AuthService.loginGoogle`). */
  activateInvited(id: string): Promise<UserWithRole> {
    return this.prisma.user.update({ where: { id }, data: { status: 'ACTIVE' }, include: { role: true } });
  }

  touchLastActive(id: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { lastActiveAt: new Date() } });
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email: emailEqualsInsensitive(email) } });
  }
}
