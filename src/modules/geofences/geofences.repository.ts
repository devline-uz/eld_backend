import { Injectable } from '@nestjs/common';
import { Prisma, type Geofence } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

const GROUP_NAME = { vehicleGroup: { select: { name: true } } } as const;
export type GeofenceWithGroup = Geofence & { vehicleGroup: { name: string } | null };

@Injectable()
export class GeofencesRepository extends BaseRepository<
  Geofence,
  Prisma.GeofenceWhereInput,
  Prisma.GeofenceWhereUniqueInput,
  Prisma.GeofenceCreateInput,
  Prisma.GeofenceUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Geofence,
    Prisma.GeofenceWhereInput,
    Prisma.GeofenceWhereUniqueInput,
    Prisma.GeofenceCreateInput,
    Prisma.GeofenceUpdateInput
  > {
    return this.prisma.geofence;
  }

  listAll(): Promise<GeofenceWithGroup[]> {
    return this.prisma.geofence.findMany({ orderBy: { createdAt: 'desc' }, include: GROUP_NAME });
  }

  /** One fence with its vehicle group's name (§20 B-104) for the detail response. */
  findWithGroup(id: string): Promise<GeofenceWithGroup | null> {
    return this.prisma.geofence.findUnique({ where: { id }, include: GROUP_NAME });
  }

  /** §20 B-104 — a `vehicleGroupId` naming no group is a 404, not a raw FK 500. */
  async groupExists(id: string): Promise<boolean> {
    return (await this.prisma.vehicleGroup.count({ where: { id } })) > 0;
  }

  /** Enabled fences worth detecting against — an alert flag, or a dwell threshold (§20 B-15), on.
   * CODE-025 — ADDRESS fences (geocoded center + radius) and POLYGON fences count too; they used
   * to be offered alert toggles in the UI but never fired. */
  activeCircleFences(): Promise<Geofence[]> {
    return this.prisma.geofence.findMany({
      where: {
        enabled: true,
        AND: [
          { OR: [{ alertOnEnter: true }, { alertOnExit: true }, { dwellMinutes: { not: null } }] },
          {
            OR: [
              { type: { in: ['CIRCLE', 'ADDRESS'] }, centerLat: { not: null }, centerLon: { not: null }, radiusMi: { not: null } },
              { type: 'POLYGON', polygon: { not: Prisma.AnyNull } },
            ],
          },
        ],
      },
    });
  }
}
