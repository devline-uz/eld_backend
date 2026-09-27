import { Injectable } from '@nestjs/common';
import type { Geofence, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

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

  listAll(): Promise<Geofence[]> {
    return this.prisma.geofence.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /** Enabled CIRCLE fences worth detecting against — an alert flag, or a dwell threshold
   * (§20 B-15), on. */
  activeCircleFences(): Promise<Geofence[]> {
    return this.prisma.geofence.findMany({
      where: {
        enabled: true,
        type: 'CIRCLE',
        OR: [{ alertOnEnter: true }, { alertOnExit: true }, { dwellMinutes: { not: null } }],
      },
    });
  }
}
