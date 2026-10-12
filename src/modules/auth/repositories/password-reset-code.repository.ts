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
}
