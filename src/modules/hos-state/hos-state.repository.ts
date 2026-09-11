import { Injectable } from '@nestjs/common';
import type { AppPlatform, DriverHosSnapshot, Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface UpsertSnapshotInput {
  driverId: string;
  computedAt: Date;
  hosEngineVersion: string;
  appPlatform?: AppPlatform | null;
  state: Prisma.InputJsonValue;
}

/**
 * TZ §3.5 / §8.6 — the only place `DriverHosSnapshot` is touched. The comparator
 * (`hos-drift.ts`) stays pure and never sees Prisma.
 */
@Injectable()
export class HosStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  findSnapshot(driverId: string): Promise<DriverHosSnapshot | null> {
    return this.prisma.driverHosSnapshot.findUnique({ where: { driverId } });
  }

  /**
   * One row per driver (`driverId` is the primary key): the app's LAST state, not a history.
   * `receivedAt` is refreshed on every post; the comparison columns are reset because they
   * describe the previous state, not this one.
   */
  upsertSnapshot(input: UpsertSnapshotInput): Promise<DriverHosSnapshot> {
    const { driverId, computedAt, hosEngineVersion, appPlatform, state } = input;
    return this.prisma.driverHosSnapshot.upsert({
      where: { driverId },
      create: { driverId, computedAt, hosEngineVersion, appPlatform: appPlatform ?? null, state },
      update: {
        computedAt,
        hosEngineVersion,
        appPlatform: appPlatform ?? null,
        state,
        receivedAt: new Date(),
        lastComparedAt: null,
        maxDriftSec: null,
      },
    });
  }

  /** Result of a comparison. `driftAlerted` stays sticky until a clean comparison clears it. */
  recordComparison(
    driverId: string,
    data: { lastComparedAt: Date; maxDriftSec: number; driftAlerted: boolean },
  ): Promise<DriverHosSnapshot> {
    return this.prisma.driverHosSnapshot.update({ where: { driverId }, data });
  }

  /**
   * Keyset pagination for the nightly sweep — `driverId` is the primary key, so this walks the
   * whole table in stable order without an OFFSET scan, however many drivers there are.
   */
  listSnapshots(afterDriverId: string | null, take: number): Promise<DriverHosSnapshot[]> {
    return this.prisma.driverHosSnapshot.findMany({
      where: afterDriverId ? { driverId: { gt: afterDriverId } } : undefined,
      orderBy: { driverId: 'asc' },
      take,
    });
  }
}
