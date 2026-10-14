import { Injectable } from '@nestjs/common';
import { PERMISSION_LEVEL_RANK, type PermissionKey } from '../../common/decorators/permission.types';
import type { ContextUser } from '../../core/context/request-context';

/** CODE-013 — a back-office socket gets a broadcast room only with READ on the screen it feeds,
 * the same level the matching REST reads need (`GET /live/fleet`, `GET /violations`). */
function canRead(user: ContextUser, key: PermissionKey): boolean {
  const level = user.permissions?.[key] ?? 'NONE';
  return PERMISSION_LEVEL_RANK[level] >= PERMISSION_LEVEL_RANK.READ;
}
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
    // Back-office broadcast rooms (fleet map, violation feed) are not for driver tokens, and only
    // for back-office users allowed to read that data (CODE-013).
    if (room === 'fleet') return user.type === 'user' && canRead(user, 'liveFleet');
    if (room === 'violations') return user.type === 'user' && canRead(user, 'hos');

    if (room.startsWith('driver:')) return room === `driver:${user.id}`;
    if (room.startsWith('user:')) return room === `user:${user.id}`;

    if (room.startsWith('vehicle:')) {
      // Single-tenant fleet (TZ §27.3): a back-office caller needs liveFleet READ (CODE-013);
      // a driver may only watch the unit they are assigned to.
      if (user.type !== 'driver') return user.type === 'user' && canRead(user, 'liveFleet');
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
