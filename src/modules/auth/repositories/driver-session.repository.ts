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
  /** MG-32 — rotation chain; a fresh login starts a new one. */
  familyId?: string;
  expiresAt: Date;
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

  revoke(id: string): Promise<DriverSession> {
    return this.prisma.driverSession.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  async revokeAllForDriver(driverId: string): Promise<void> {
    await this.prisma.driverSession.updateMany({
      where: { driverId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
