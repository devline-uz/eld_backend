import { Injectable } from '@nestjs/common';
import { Prisma, type Geofence } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

const GROUP_NAME = {
  vehicleGroup: { select: { name: true } },
  vehicles: {
    select: { vehicle: { select: { id: true, unitNumber: true } } },
    orderBy: { vehicle: { unitNumber: 'asc' } },
  },
} as const;
export type GeofenceWithGroup = Geofence & {
  vehicleGroup: { name: string } | null;
  vehicles: Array<{ vehicle: { id: string; unitNumber: string } }>;
};
/** An active fence plus the ids of the units it is scoped to (empty = not unit-scoped). */
export type ActiveGeofence = Geofence & { vehicles: Array<{ vehicleId: string }> };

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

  /** How many of `ids` name a live (not soft-deleted) unit. */
  countLiveVehicles(ids: string[]): Promise<number> {
    return this.prisma.vehicle.count({ where: { id: { in: ids }, deletedAt: null } });
  }

  /** Enabled fences worth detecting against — an alert flag, or a dwell threshold (§20 B-15), on.
   * CODE-025 — ADDRESS fences (geocoded center + radius) and POLYGON fences count too; they used
   * to be offered alert toggles in the UI but never fired. */
  activeCircleFences(): Promise<ActiveGeofence[]> {
    return this.prisma.geofence.findMany({
      include: { vehicles: { select: { vehicleId: true } } },
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
