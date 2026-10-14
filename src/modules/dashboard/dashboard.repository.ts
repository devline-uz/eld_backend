import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface UnidentifiedSummary {
  /** PENDING — nobody assigned yet. */
  total: number;
  totalDurationSec: number;
  /** PENDING_CONFIRMATION — assigned by the carrier, awaiting the driver's confirmation. */
  awaitingDriver: number;
  awaitingDriverDurationSec: number;
}

/** Aggregates `GET /dashboard/summary` needs that no feature module exposes as a whole-table total. */
@Injectable()
export class DashboardRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** CODE-021 — count and summed duration of EVERY pending unidentified-driving segment.
   * CODE-029 — `awaitingDriver*`: segments the carrier assigned that wait for the driver's
   * confirmation in the app (PENDING_CONFIRMATION), reported apart from the unassigned ones. */
  async pendingUnidentified(): Promise<UnidentifiedSummary> {
    const rows = await this.prisma.unidentifiedSegment.groupBy({
      by: ['status'],
      where: { status: { in: ['PENDING', 'PENDING_CONFIRMATION'] } },
      _count: { _all: true },
      _sum: { durationSec: true },
    });
    const pick = (status: string) => rows.find((r) => r.status === status);
    const pending = pick('PENDING');
    const awaiting = pick('PENDING_CONFIRMATION');
    return {
      total: pending?._count._all ?? 0,
      totalDurationSec: pending?._sum.durationSec ?? 0,
      awaitingDriver: awaiting?._count._all ?? 0,
      awaitingDriverDurationSec: awaiting?._sum.durationSec ?? 0,
    };
  }
}
