import { Injectable } from '@nestjs/common';
import type { Prisma, TelemetryPoint } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import type { TelemetryRow } from './telemetry.mapper';

/** TZ §5.6 — Virtual Dashboard storage. Monthly-partitioned by `time`, imperial units only. */
@Injectable()
export class TelemetryRepository extends BaseRepository<
  TelemetryPoint,
  Prisma.TelemetryPointWhereInput,
  Prisma.TelemetryPointWhereUniqueInput,
  Prisma.TelemetryPointCreateInput,
  Prisma.TelemetryPointUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    TelemetryPoint,
    Prisma.TelemetryPointWhereInput,
    Prisma.TelemetryPointWhereUniqueInput,
    Prisma.TelemetryPointCreateInput,
    Prisma.TelemetryPointUpdateInput
  > {
    return this.prisma.telemetryPoint;
  }

  /** Partitions for late points are created on demand, same as `EldEvent` (§5.6). */
  async ensurePartitions(months: string[]): Promise<void> {
    for (const month of months) {
      await this.prisma.$executeRawUnsafe(
        `SELECT create_monthly_partition('TelemetryPoint', $1::date)`,
        month,
      );
    }
  }

  /** `skipDuplicates` makes a replayed offline queue idempotent on the (time, vehicleId) PK. */
  async insertMany(rows: TelemetryRow[]): Promise<number> {
    if (!rows.length) return 0;
    const result = await this.prisma.telemetryPoint.createMany({
      data: rows as unknown as Prisma.TelemetryPointCreateManyInput[],
      skipDuplicates: true,
    });
    return result.count;
  }

  latestForVehicle(vehicleId: string): Promise<TelemetryPoint | null> {
    return this.prisma.telemetryPoint.findFirst({
      where: { vehicleId },
      orderBy: { time: 'desc' },
    });
  }

  /** §20 B-4 / telemetry read — every point in `[from, to)` for one vehicle, oldest first. Used
   * server-side only (day segmentation); never shipped raw to a browser (~60k pts/day, TZ §20.1). */
  listRange(vehicleId: string, from: Date, to: Date): Promise<TelemetryPoint[]> {
    return this.prisma.telemetryPoint.findMany({
      where: { vehicleId, time: { gte: from, lt: to } },
      orderBy: { time: 'asc' },
    });
  }

  /** `GET /vehicles/:id/telemetry` read path — most recent N points, newest first. */
  listRecent(vehicleId: string, limit: number, from?: Date, to?: Date): Promise<TelemetryPoint[]> {
    return this.prisma.telemetryPoint.findMany({
      where: {
        vehicleId,
        ...((from || to) && { time: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
      },
      orderBy: { time: 'desc' },
      take: limit,
    });
  }
}
