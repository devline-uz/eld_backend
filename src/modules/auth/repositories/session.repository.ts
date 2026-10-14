import { Injectable } from '@nestjs/common';
import type { Session } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

export interface CreateSessionInput {
  userId: string;
  refreshHash: string;
  userAgent?: string;
  ip?: string;
  deviceLabel?: string;
  /** MG-32 — rotation chain; a fresh login starts a new one. */
  familyId?: string;
  expiresAt: Date;
}

/** B-50 — `GET /me/sessions` shape. Never `refreshHash`/`userId` (TZ §6.5 — a refresh-token
 * hash must never reach the browser, and `userId` is redundant/leaky on a "your sessions" list). */
export interface SafeSession {
  id: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  lastSeenAt: Date;
}

const SAFE_SESSION_SELECT = {
  id: true,
  deviceLabel: true,
  userAgent: true,
  ip: true,
  lastSeenAt: true,
} as const;

/**
 * Back-office `Session` (User refresh tokens). Rotation keeps the previous row around with
 * `revokedAt` set instead of deleting it, so a replayed refresh token can still be found and
 * flagged as reuse (TZ §6.5 "rotatsiya har ishlatishda").
 */
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateSessionInput): Promise<Session> {
    return this.prisma.session.create({ data: input });
  }

  findByRefreshHash(refreshHash: string): Promise<Session | null> {
    return this.prisma.session.findFirst({ where: { refreshHash } });
  }

  findActiveById(id: string, userId: string): Promise<Session | null> {
    return this.prisma.session.findFirst({
      where: { id, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  /** B-50 — `select`, not the full row: `refreshHash`/`userId` must never leave this module. */
  listActiveForUser(userId: string): Promise<SafeSession[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: SAFE_SESSION_SELECT,
    });
  }

  /**
   * MG-32 — atomic rotation: revokes `oldId` (marking it `rotatedAt`) and creates its successor
   * in ONE transaction, but only for the caller that wins the `revokedAt IS NULL` claim. Returns
   * `null` for a loser (a parallel refresh already rotated it) so the caller can take the grace path.
   */
  rotate(oldId: string, input: CreateSessionInput): Promise<Session | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const claim = await tx.session.updateMany({
        where: { id: oldId, revokedAt: null },
        data: { revokedAt: now, rotatedAt: now },
      });
      if (claim.count !== 1) return null;
      return tx.session.create({ data: input });
    });
  }

  /** MG-32 — reuse detected: revoke only the rotation chain the replayed token belongs to. */
  async revokeFamily(familyId: string): Promise<number> {
    const r = await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return r.count;
  }

  revoke(id: string): Promise<Session> {
    return this.prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** B-50 "Sign out everywhere" — revokes every active session for the user except
   * `exceptId` (the caller's own current session), and returns how many were revoked. */
  async revokeAllForUserExcept(userId: string, exceptId?: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptId && { id: { not: exceptId } }) },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
