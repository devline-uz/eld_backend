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

  listActiveForDriver(driverId: string): Promise<DriverSession[]> {
    return this.prisma.driverSession.findMany({
      where: { driverId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
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
