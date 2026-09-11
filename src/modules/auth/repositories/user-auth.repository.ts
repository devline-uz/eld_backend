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

  setTwoFactorSecret(id: string, twoFactorSecret: string | null): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { twoFactorSecret } });
  }

  enableTwoFactor(id: string, recoveryCodeHashes: string[]): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { twoFactorEnabled: true, recoveryCodes: recoveryCodeHashes },
    });
  }

  disableTwoFactor(id: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { twoFactorEnabled: false, twoFactorSecret: null, recoveryCodes: [] },
    });
  }

  consumeRecoveryCode(id: string, remainingHashes: string[]): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { recoveryCodes: remainingHashes } });
  }
}
