import { Injectable } from '@nestjs/common';
import type { PushToken } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * TZ §14 push tokens — MB-1. Kept as its own repository (not folded into `MobileRepository`)
 * per Phase 6b's "prefer your own new files over growing shared ones" rule; `MobileRepository`
 * already exposes `findPushTokens` for other modules to read.
 */
@Injectable()
export class PushTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByToken(token: string): Promise<PushToken | null> {
    return this.prisma.pushToken.findUnique({ where: { token } });
  }

  /**
   * Upsert on the unique `token` column. A token can move devices (reinstall, device
   * hand-me-down) and even carriers within this driver pool, so the upsert always re-owns it
   * to the calling driver and refreshes `lastSeenAt` rather than rejecting a foreign-owned row.
   */
  upsert(driverId: string, token: string, platform: 'IOS' | 'ANDROID', deviceLabel: string | null): Promise<PushToken> {
    return this.prisma.pushToken.upsert({
      where: { token },
      create: { driverId, token, platform, deviceLabel, lastSeenAt: new Date() },
      update: { driverId, platform, deviceLabel, lastSeenAt: new Date() },
    });
  }

  async deleteOwnedByDriver(driverId: string, token: string): Promise<boolean> {
    const result = await this.prisma.pushToken.deleteMany({ where: { token, driverId } });
    return result.count > 0;
  }
}
