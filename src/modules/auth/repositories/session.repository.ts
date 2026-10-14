import { Injectable } from '@nestjs/common';
import type { Session } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

export interface CreateSessionInput {
  userId: string;
  refreshHash: string;
  userAgent?: string;
  ip?: string;
  deviceLabel?: string;
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
   * CODE-012 — is the session an access token names still live? A refresh rotates the row into a
   * new one (`rotatedToId`) without ending the sign-in, so the chain is followed to its head; an
   * explicit revoke/logout/expiry of the head ends every token issued along it.
   */
  async isLineageLive(id: string, userId: string, maxHops = 10): Promise<boolean> {
    let nextId: string | null = id;
    for (let hop = 0; nextId && hop <= maxHops; hop += 1) {
      const row: Pick<Session, 'userId' | 'revokedAt' | 'expiresAt' | 'rotatedToId'> | null =
        await this.prisma.session.findUnique({
          where: { id: nextId },
          select: { userId: true, revokedAt: true, expiresAt: true, rotatedToId: true },
        });
      if (!row || row.userId !== userId) return false;
      if (!row.revokedAt) return row.expiresAt > new Date();
      nextId = row.rotatedToId;
    }
    return false;
  }

  /**
   * CODE-019 — refresh rotation as one atomic step: the new session is created and the old one is
   * marked rotated ONLY if it is still unrevoked. `null` = another request rotated/revoked it first
   * (nothing is written).
   */
  async rotate(oldId: string, input: CreateSessionInput): Promise<Session | null> {
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.session.create({ data: input });
      const { count } = await tx.session.updateMany({
        where: { id: oldId, revokedAt: null },
        data: { revokedAt: new Date(), rotatedToId: next.id },
      });
      if (count === 0) {
        await tx.session.delete({ where: { id: next.id } });
        return null;
      }
      return next;
    });
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
