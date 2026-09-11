import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

/** TZ §3.5 — every `prisma.*` call for the nightly IFTA computation lives here. */
@Injectable()
export class IftaSegmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  distinctVehicleIdsWithTelemetry(from: Date, to: Date): Promise<{ vehicleId: string }[]> {
    return this.prisma.telemetryPoint.findMany({
      where: { time: { gte: from, lte: to } },
      distinct: ['vehicleId'],
      select: { vehicleId: true },
    });
  }

  existingSegments(vehicleId: string, date: Date): Promise<{ jurisdiction: string; locked: boolean }[]> {
    return this.prisma.iftaSegment.findMany({
      where: { vehicleId, date },
      select: { jurisdiction: true, locked: true },
    });
  }

  telemetryForVehicleDay(vehicleId: string, from: Date, to: Date) {
    return this.prisma.telemetryPoint.findMany({
      where: { vehicleId, time: { gte: from, lte: to } },
      orderBy: { time: 'asc' },
      select: { time: true, latitude: true, longitude: true, odometerMi: true, driverId: true },
    });
  }

  upsertSegment(
    vehicleId: string,
    jurisdiction: string,
    date: Date,
    driverId: string | null,
    distanceMi: number,
  ) {
    return this.prisma.iftaSegment.upsert({
      where: { vehicleId_jurisdiction_date: { vehicleId, jurisdiction, date } },
      create: { vehicleId, driverId, jurisdiction, date, distanceMi },
      update: { distanceMi, driverId },
    });
  }

  async lockQuarter(qStart: Date, qEnd: Date): Promise<number> {
    const where: Prisma.IftaSegmentWhereInput = { locked: false, date: { gte: qStart, lte: qEnd } };
    const res = await this.prisma.iftaSegment.updateMany({ where, data: { locked: true } });
    return res.count;
  }
}
