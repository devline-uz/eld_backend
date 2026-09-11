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

  /** Enabled CIRCLE fences with at least one alert flag on — the only ones worth detecting against. */
  activeCircleFences(): Promise<Geofence[]> {
    return this.prisma.geofence.findMany({
      where: { enabled: true, type: 'CIRCLE', OR: [{ alertOnEnter: true }, { alertOnExit: true }] },
    });
  }
}
