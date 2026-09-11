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

  listActiveForUser(userId: string): Promise<Session[]> {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
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
}
