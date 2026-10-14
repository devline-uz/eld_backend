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

  /** A new password also lifts a CODE-082 lockout (the owner just proved control of the mailbox). */
  updatePasswordHash(id: string, passwordHash: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
  }

  /**
   * CODE-082 — one more consecutive wrong password. At `threshold` the account is locked until
   * `lockUntil` and the counter starts over, so the next lock needs another full run of failures.
   * Returns whether this failure locked the account.
   */
  async recordFailedLogin(id: string, threshold: number, lockUntil: Date): Promise<boolean> {
    const { failedLoginCount } = await this.prisma.user.update({
      where: { id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (failedLoginCount < threshold) return false;
    await this.prisma.user.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: lockUntil } });
    return true;
  }

  /** CODE-082 — a successful password login clears the failure streak (no write when already clean). */
  async clearFailedLogins(id: string): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id, OR: [{ failedLoginCount: { gt: 0 } }, { lockedUntil: { not: null } }] },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email: emailEqualsInsensitive(email) } });
  }
}
