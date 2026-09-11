import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * TZ §12.4 — who may join which realtime room.
 *
 * Before this existed, `ALLOWED_ROOM_PATTERN` was the only gate on `subscribe`, so any
 * authenticated socket (including a driver token) could join `conversation:{id}` and read
 * every message pushed into a thread it is not part of, or `vehicle:{id}` for any unit in the
 * fleet. Room membership is authorization, so it is decided here and unit-tested.
 */
@Injectable()
export class RealtimeRoomAuthorizer {
  constructor(private readonly prisma: PrismaService) {}

  async mayJoin(room: string, user: ContextUser): Promise<boolean> {
    // Back-office broadcast rooms (fleet map, violation feed) are not for driver tokens.
    if (room === 'fleet' || room === 'violations') return user.type !== 'driver';

    if (room.startsWith('driver:')) return room === `driver:${user.id}`;
    if (room.startsWith('user:')) return room === `user:${user.id}`;

    if (room.startsWith('vehicle:')) {
      // A back-office caller already needed a valid token and the fleet is single-tenant
      // (TZ §27.3); a driver may only watch the unit they are assigned to.
      if (user.type !== 'driver') return true;
      const driver = await this.prisma.driver.findUnique({
        where: { id: user.id },
        select: { assignedVehicleId: true },
      });
      return !!driver?.assignedVehicleId && room === `vehicle:${driver.assignedVehicleId}`;
    }

    if (room.startsWith('conversation:')) {
      const conversationId = room.slice('conversation:'.length);
      const count = await this.prisma.conversationParticipant.count({
        where:
          user.type === 'driver'
            ? { conversationId, driverId: user.id }
            : { conversationId, userId: user.id },
      });
      return count > 0;
    }

    return false;
  }
}
