import { Injectable } from '@nestjs/common';
import type { DriverPasswordResetCode } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

/** B-160 — per-driver reset budget (independent of the per-code 5-attempt cap). */
export const RESET_THROTTLE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RESET_MAX_CODES_PER_WINDOW = 5;
export const RESET_MAX_FAILURES_PER_WINDOW = 15;

/** MB-17/MB-16 — storage for the hashed driver reset code and the admin "driver requested a reset" inbox rows. */
@Injectable()
export class DriverResetCodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One row per driver: a new code overwrites (and so invalidates) the previous one. B-158 —
   * returns null (nothing issued, no mail) while a live code is younger than `cooldownMs`, so
   * re-requesting cannot reset the attempt counter faster than once per cooldown. */
  async upsert(
    driverId: string,
    salt: string,
    codeHash: string,
    expiresAt: Date,
    cooldownMs = 60_000,
  ): Promise<DriverPasswordResetCode | null> {
    const now = Date.now();
    const existing = await this.prisma.driverPasswordResetCode.findUnique({ where: { driverId } });
    if (existing && existing.expiresAt.getTime() > now && existing.createdAt.getTime() > now - cooldownMs) return null;
    // B-160 — per-driver daily budget: no code is stored (or mailed) past the cap or while locked.
    if (!(await this.reserveIssue(driverId, new Date(now)))) return null;
    return this.prisma.driverPasswordResetCode.upsert({
      where: { driverId },
      create: { driverId, salt, codeHash, expiresAt },
      update: { salt, codeHash, expiresAt, attempts: 0, createdAt: new Date() },
    });
  }

  /** B-160 — opens a fresh 24 h window once the previous one (and any lock) has lapsed. */
  private async rollWindow(driverId: string, now: Date): Promise<void> {
    // ON CONFLICT DO NOTHING — a Prisma upsert races (P2002) under concurrent forgot/reset calls.
    await this.prisma.driverPasswordResetThrottle.createMany({ data: [{ driverId, windowStart: now }], skipDuplicates: true });
    await this.prisma.driverPasswordResetThrottle.updateMany({
      where: {
        driverId,
        windowStart: { lte: new Date(now.getTime() - RESET_THROTTLE_WINDOW_MS) },
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { windowStart: now, codesIssued: 0, failedAttempts: 0, lockedUntil: null },
    });
  }

  /** B-160 — atomically spends one of the window's `maxCodes` issues. False = cap reached or locked. */
  async reserveIssue(driverId: string, now: Date, maxCodes = RESET_MAX_CODES_PER_WINDOW): Promise<boolean> {
    await this.rollWindow(driverId, now);
    const res = await this.prisma.driverPasswordResetThrottle.updateMany({
      where: { driverId, codesIssued: { lt: maxCodes }, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
      data: { codesIssued: { increment: 1 } },
    });
    return res.count > 0;
  }

  /** B-160 — true while code reset is locked for this driver. */
  async isLocked(driverId: string, now: Date): Promise<boolean> {
    const row = await this.prisma.driverPasswordResetThrottle.findUnique({ where: { driverId }, select: { lockedUntil: true } });
    return Boolean(row?.lockedUntil && row.lockedUntil.getTime() > now.getTime());
  }

  /** B-160 — counts one wrong code in the window; at `maxFailures` locks reset for 24 h and
   * deletes the live code. Returns true when the driver is (now) locked. */
  async recordFailure(driverId: string, now: Date, maxFailures = RESET_MAX_FAILURES_PER_WINDOW): Promise<boolean> {
    await this.rollWindow(driverId, now);
    const row = await this.prisma.driverPasswordResetThrottle.update({
      where: { driverId },
      data: { failedAttempts: { increment: 1 } },
    });
    if (row.failedAttempts < maxFailures) return false;
    await this.prisma.driverPasswordResetThrottle.updateMany({
      where: { driverId, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
      data: { lockedUntil: new Date(now.getTime() + RESET_THROTTLE_WINDOW_MS) },
    });
    await this.consume(driverId);
    return true;
  }

  find(driverId: string): Promise<DriverPasswordResetCode | null> {
    return this.prisma.driverPasswordResetCode.findUnique({ where: { driverId } });
  }

  /** B-158 — atomically spends one attempt on THIS code (same hash, live, under the cap) before
   * the comparison, so concurrent guesses cannot exceed `maxAttempts`. False = nothing to spend. */
  async claimAttempt(driverId: string, codeHash: string, maxAttempts: number, now: Date): Promise<boolean> {
    const res = await this.prisma.driverPasswordResetCode.updateMany({
      where: { driverId, codeHash, attempts: { lt: maxAttempts }, expiresAt: { gt: now } },
      data: { attempts: { increment: 1 } },
    });
    return res.count > 0;
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
  async notifyAdminsOfResetRequest(
    driver: { id: string; firstName: string; lastName: string; username: string },
    dedupeSince: Date,
    /** Why no code was mailed: no email on file, or the driver-email-change hold is active. */
    reason: 'NO_EMAIL' | 'EMAIL_CHANGE_HOLD' = 'NO_EMAIL',
  ): Promise<number> {
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
        body:
          reason === 'EMAIL_CHANGE_HOLD'
            ? `${name} (${driver.username}) requested a password reset, but their email was changed recently, so no code was emailed (security hold). Verify the request and reset it from the driver profile.`
            : `${name} (${driver.username}) requested a password reset but has no email on file. Reset it from the driver profile.`,
        objectType: 'Driver',
        objectId: driver.id,
        category: 'drivers',
        severity: 'INFO' as const,
      })),
    });
    return res.count;
  }
}
