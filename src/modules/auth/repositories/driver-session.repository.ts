import { Injectable } from '@nestjs/common';
import type { DriverSession } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

export interface CreateDriverSessionInput {
  driverId: string;
  refreshHash: string;
  userAgent?: string;
  ip?: string;
  deviceLabel?: string;
  appVersion?: string;
  /** MD-195 — device identity (optional: legacy logins carry none). */
  deviceId?: string;
  platform?: string;
  formFactor?: string;
  /** MD-195 — carried over on rotation so the motion/backlog signals survive a refresh. */
  lastMotionAt?: Date;
  pendingCount?: number;
  oldestPendingAt?: Date;
  /** MG-32 — rotation chain; a fresh login starts a new one. */
  familyId?: string;
  expiresAt: Date;
}

/** MD-195 — a motion report newer than this blocks a login from another device. */
export const MOTION_WINDOW_MS = 120_000;

/** MD-195 — per-driver advisory-lock key shared by device takeover and refresh rotation. */
const sessionLockKey = (driverId: string): string => `driver-session:${driverId}`;

export type ExclusiveLoginResult =
  | { kind: 'moving'; moving: DriverSession }
  | {
      kind: 'created';
      session: DriverSession;
      /** Every family ended as REPLACED (other devices AND older same-device sessions). */
      replaced: Array<{ session: DriverSession; familyIds: string[] }>;
    };

export interface ReplacementInfo {
  byDeviceLabel: string;
  at: Date;
}

/** Mirrors `SessionRepository` for the Driver subject (TZ §6.1). */
@Injectable()
export class DriverSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateDriverSessionInput): Promise<DriverSession> {
    return this.prisma.driverSession.create({ data: input });
  }

  findByRefreshHash(refreshHash: string): Promise<DriverSession | null> {
    return this.prisma.driverSession.findFirst({ where: { refreshHash } });
  }

  findById(id: string): Promise<DriverSession | null> {
    return this.prisma.driverSession.findUnique({ where: { id } });
  }

  countActiveInFamily(driverId: string, familyId: string): Promise<number> {
    return this.prisma.driverSession.count({
      where: { driverId, revokedAt: null, OR: [{ familyId }, { id: familyId }] },
    });
  }

  listActiveForDriver(driverId: string): Promise<DriverSession[]> {
    return this.prisma.driverSession.findMany({
      where: { driverId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /** MG-32 — see `SessionRepository.rotate`. */
  rotate(oldId: string, input: CreateDriverSessionInput): Promise<DriverSession | null> {
    return this.prisma.$transaction(async (tx) => {
      // MD-195 / B-174 — same per-driver lock as `createExclusive`, so a takeover can never miss a
      // successor row that a concurrent rotation is about to commit.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, sessionLockKey(input.driverId));
      const now = new Date();
      const claim = await tx.driverSession.updateMany({
        where: { id: oldId, revokedAt: null },
        data: { revokedAt: now, rotatedAt: now },
      });
      if (claim.count !== 1) return null;
      return tx.driverSession.create({ data: input });
    });
  }

  /** MG-32 — reuse detected: revoke only the rotation chain the replayed token belongs to. */
  async revokeFamily(familyId: string): Promise<number> {
    const r = await this.prisma.driverSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count;
  }

  /** At least one unrevoked, unexpired app session — a driver access token is honoured only then. */
  async hasLiveSession(driverId: string): Promise<boolean> {
    const live = await this.prisma.driverSession.findFirst({
      where: { driverId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return live !== null;
  }

  revoke(id: string): Promise<DriverSession> {
    return this.prisma.driverSession.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  async revokeAllForDriver(driverId: string): Promise<void> {
    await this.prisma.driverSession.updateMany({
      where: { driverId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Every row of the rotation family that `sessionId` belongs to (the row itself included). */
  private async familyRows(driverId: string, sessionId: string): Promise<DriverSession[]> {
    const row = await this.prisma.driverSession.findUnique({ where: { id: sessionId } });
    if (!row || row.driverId !== driverId) return [];
    const familyId = row.familyId ?? row.id;
    return this.prisma.driverSession.findMany({ where: { driverId, OR: [{ familyId }, { id: familyId }] } });
  }

  /**
   * MD-195 — per-session liveness of a driver access token (`sid` claim). A rotation keeps the
   * family alive, so an access token issued before a refresh stays valid while ANY family member is
   * unrevoked and unexpired. A family whose head was ended by a takeover reports `replaced`.
   */
  async lineageState(driverId: string, sessionId: string): Promise<{ live: boolean; replaced: ReplacementInfo | null }> {
    const rows = await this.familyRows(driverId, sessionId);
    const now = new Date();
    if (rows.some((r) => r.revokedAt === null && r.expiresAt > now)) return { live: true, replaced: null };
    return { live: false, replaced: this.replacementOf(rows) };
  }

  /** The takeover that ended the family of the given (revoked) session, if any. */
  async replacementFor(driverId: string, sessionId: string): Promise<ReplacementInfo | null> {
    return this.replacementOf(await this.familyRows(driverId, sessionId));
  }

  private replacementOf(rows: DriverSession[]): ReplacementInfo | null {
    const hit = rows
      .filter((r) => r.revokedReason === 'REPLACED' && r.revokedAt)
      .sort((a, b) => (b.revokedAt as Date).getTime() - (a.revokedAt as Date).getTime())[0];
    return hit ? { byDeviceLabel: hit.replacedByDeviceLabel ?? 'another device', at: hit.revokedAt as Date } : null;
  }

  /**
   * MD-195 / B-174 — the single-device login, serialised per driver (advisory lock) so two
   * simultaneous logins from two devices cannot both survive, and a concurrent refresh rotation
   * cannot slip a successor past the takeover. Inside the lock: a session of ANOTHER device (or a
   * legacy null-deviceId one) that moved within `motionWindowMs` refuses the login; otherwise the
   * new session is created and every other live family of the driver — other devices and older
   * sessions claiming the same `deviceId` (B-175: a spoofed deviceId must not keep two devices
   * alive) — is revoked as REPLACED, whole family at once.
   */
  createExclusive(input: CreateDriverSessionInput & { deviceId: string; deviceLabel: string }, motionWindowMs: number): Promise<ExclusiveLoginResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, sessionLockKey(input.driverId));
      const now = new Date();
      const live = await tx.driverSession.findMany({
        where: { driverId: input.driverId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { lastSeenAt: 'desc' },
      });
      const moving = live
        .filter((s) => s.deviceId !== input.deviceId && s.lastMotionAt && now.getTime() - s.lastMotionAt.getTime() <= motionWindowMs)
        .sort((a, b) => (b.lastMotionAt as Date).getTime() - (a.lastMotionAt as Date).getTime())[0];
      if (moving) return { kind: 'moving' as const, moving };
      const session = await tx.driverSession.create({ data: input });
      const replaced: Array<{ session: DriverSession; familyIds: string[] }> = [];
      const seen = new Set<string>();
      for (const s of live) {
        const familyId = s.familyId ?? s.id;
        if (seen.has(familyId)) continue;
        seen.add(familyId);
        await tx.driverSession.updateMany({
          where: { driverId: input.driverId, revokedAt: null, OR: [{ familyId }, { id: familyId }] },
          data: { revokedAt: now, revokedReason: 'REPLACED', replacedByDeviceId: input.deviceId, replacedByDeviceLabel: input.deviceLabel },
        });
        const fam = await tx.driverSession.findMany({
          where: { driverId: input.driverId, OR: [{ familyId }, { id: familyId }] },
          select: { id: true },
        });
        replaced.push({ session: s, familyIds: fam.map((f) => f.id) });
      }
      return { kind: 'created' as const, session, replaced };
    });
  }

  /** MD-195 — record that the vehicle moved under this session (the family's live head is updated). */
  async markMotion(sessionId: string, at: Date): Promise<void> {
    const row = await this.prisma.driverSession.findUnique({ where: { id: sessionId }, select: { id: true, familyId: true } });
    if (!row) return;
    const familyId = row.familyId ?? row.id;
    await this.prisma.driverSession.updateMany({
      where: { revokedAt: null, OR: [{ familyId }, { id: familyId }] },
      data: { lastMotionAt: at },
    });
  }

  /** MD-195 / D-161 — authenticated driver activity on this session (the family's live head is updated). */
  async touchLastSeen(sessionId: string, at: Date): Promise<void> {
    const row = await this.prisma.driverSession.findUnique({ where: { id: sessionId }, select: { id: true, familyId: true } });
    if (!row) return;
    const familyId = row.familyId ?? row.id;
    await this.prisma.driverSession.updateMany({
      where: { revokedAt: null, OR: [{ familyId }, { id: familyId }] },
      data: { lastSeenAt: at },
    });
  }

  /** MD-195 — record the app-reported offline backlog (from `/mobile/sync`) on the family's live head. */
  async setBacklog(sessionId: string, pendingCount: number | null, oldestPendingAt: Date | null): Promise<void> {
    const row = await this.prisma.driverSession.findUnique({ where: { id: sessionId }, select: { id: true, familyId: true } });
    if (!row) return;
    const familyId = row.familyId ?? row.id;
    await this.prisma.driverSession.updateMany({
      where: { revokedAt: null, OR: [{ familyId }, { id: familyId }] },
      data: { pendingCount, oldestPendingAt },
    });
  }
}
