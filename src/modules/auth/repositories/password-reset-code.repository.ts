import { Injectable } from '@nestjs/common';
import type { PasswordResetCode } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

/** Web "Forgot password?" — the only place `prisma.passwordResetCode` is touched. */
@Injectable()
export class PasswordResetCodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: { userId: string; codeHash: string; expiresAt: Date }): Promise<PasswordResetCode> {
    return this.prisma.passwordResetCode.create({ data });
  }

  /** The newest not-yet-consumed code for the user (expired rows included — the caller decides). */
  findLatestActive(userId: string): Promise<PasswordResetCode | null> {
    return this.prisma.passwordResetCode.findFirst({
      where: { userId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Retires every open code of the user (a new code replaces the old one; a reset ends them all). */
  async invalidateAllForUser(userId: string): Promise<void> {
    await this.prisma.passwordResetCode.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  /** Counts one wrong guess atomically and returns the new total. */
  async incrementAttempts(id: string): Promise<number> {
    const row = await this.prisma.passwordResetCode.update({
      where: { id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return row.attempts;
  }

  /** Single-use guard: true only for the one caller that flips `consumedAt` from null. */
  async consume(id: string): Promise<boolean> {
    const { count } = await this.prisma.passwordResetCode.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }

  /**
   * B-84 email-change hold — a reset was requested for an address confirmed too recently, so no
   * code was mailed. The org administrators (ACTIVE `ADMIN` / `SUPER_ADMIN`, never the account
   * itself) get one in-app notice, deduped while an unread one from `dedupeSince` exists — the
   * same fallback the driver forgot flow uses (`DriverResetCodeRepository.notifyAdminsOfResetRequest`).
   */
  async notifyAdminsOfHeldReset(
    user: { id: string; firstName: string; lastName: string; email: string },
    dedupeSince: Date,
  ): Promise<number> {
    const pending = await this.prisma.notification.findFirst({
      where: { type: 'USER_PASSWORD_RESET_HELD', objectId: user.id, readAt: null, createdAt: { gte: dedupeSince } },
      select: { id: true },
    });
    if (pending) return 0;
    const admins = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', id: { not: user.id }, role: { key: { in: ['ADMIN', 'SUPER_ADMIN'] } } },
      select: { id: true },
    });
    if (admins.length === 0) return 0;
    const name = `${user.firstName} ${user.lastName}`.trim() || user.email;
    const res = await this.prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type: 'USER_PASSWORD_RESET_HELD',
        kind: 'OTHER' as const,
        title: 'Password reset held',
        body:
          `${name} requested a password reset, but their email was changed recently, so no code was emailed ` +
          '(security hold). Verify the request with them before helping them sign in.',
        objectType: 'User',
        objectId: user.id,
        category: 'users',
        severity: 'INFO' as const,
      })),
    });
    return res.count;
  }
}
