import { Injectable } from '@nestjs/common';
import type { DriverPasswordResetCode } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

/** MB-17/MB-16 — storage for the hashed driver reset code and the admin "driver requested a reset" inbox rows. */
@Injectable()
export class DriverResetCodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One row per driver: a new code overwrites (and so invalidates) the previous one. */
  upsert(driverId: string, salt: string, codeHash: string, expiresAt: Date): Promise<DriverPasswordResetCode> {
    return this.prisma.driverPasswordResetCode.upsert({
      where: { driverId },
      create: { driverId, salt, codeHash, expiresAt },
      update: { salt, codeHash, expiresAt, attempts: 0, createdAt: new Date() },
    });
  }

  find(driverId: string): Promise<DriverPasswordResetCode | null> {
    return this.prisma.driverPasswordResetCode.findUnique({ where: { driverId } });
  }

  /** Atomically records a wrong attempt and returns the new count. */
  async incrementAttempts(driverId: string): Promise<number | null> {
    try {
      const row = await this.prisma.driverPasswordResetCode.update({
        where: { driverId },
        data: { attempts: { increment: 1 } },
      });
      return row.attempts;
    } catch {
      return null;
    }
  }

  /** Returns true when this call removed the row — the caller that gets `true` owns the single use. */
  async consume(driverId: string): Promise<boolean> {
    const res = await this.prisma.driverPasswordResetCode.deleteMany({ where: { driverId } });
    return res.count > 0;
  }

  /**
   * MB-16 — in-app notification for every ACTIVE ADMIN (single-carrier install, tz §27.3).
   * Skipped when an unread request for the same driver is already pending (anti-spam).
   */
  async notifyAdminsOfResetRequest(driver: { id: string; firstName: string; lastName: string; username: string }, dedupeSince: Date): Promise<number> {
    const pending = await this.prisma.notification.findFirst({
      where: { type: 'DRIVER_PASSWORD_RESET', objectId: driver.id, readAt: null, createdAt: { gte: dedupeSince } },
      select: { id: true },
    });
    if (pending) return 0;
    const admins = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', role: { key: 'ADMIN' } },
      select: { id: true },
    });
    if (admins.length === 0) return 0;
    const name = `${driver.firstName} ${driver.lastName}`.trim() || driver.username;
    const res = await this.prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type: 'DRIVER_PASSWORD_RESET',
        kind: 'OTHER' as const,
        title: 'Driver password reset requested',
        body: `${name} (${driver.username}) requested a password reset but has no email on file. Reset it from the driver profile.`,
        objectType: 'Driver',
        objectId: driver.id,
        category: 'drivers',
        severity: 'INFO' as const,
      })),
    });
    return res.count;
  }
}
