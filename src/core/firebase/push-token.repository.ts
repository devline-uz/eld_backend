import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** `PushToken` access for `PushService` (core layer, so it cannot import modules/mobile). */
@Injectable()
export class PushTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByDriver(driverId: string): Promise<Array<{ token: string }>> {
    return this.prisma.pushToken.findMany({ where: { driverId }, select: { token: true } });
  }

  async deleteTokens(tokens: string[]): Promise<number> {
    const r = await this.prisma.pushToken.deleteMany({ where: { token: { in: tokens } } });
    return r.count;
  }
}
