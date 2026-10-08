import { Injectable } from '@nestjs/common';
import type {
  Carrier,
  DailyLog,
  DataTransfer,
  Driver,
  DriverDayDetails,
  EldEvent,
  Prisma,
  UnidentifiedSegment,
  User,
  Vehicle,
} from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import type { DayTrip } from '../logs/day-extras';
import { findDayTrips } from '../logs/logs.repository';

/** TZ §3.5 / §10 — every database call of the eRODS transfer module lives here. */
@Injectable()
export class TransfersRepository extends BaseRepository<
  DataTransfer,
  Prisma.DataTransferWhereInput,
  Prisma.DataTransferWhereUniqueInput,
  Prisma.DataTransferCreateInput,
  Prisma.DataTransferUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    DataTransfer,
    Prisma.DataTransferWhereInput,
    Prisma.DataTransferWhereUniqueInput,
    Prisma.DataTransferCreateInput,
    Prisma.DataTransferUpdateInput
  > {
    return this.prisma.dataTransfer;
  }

  /** B-46 — `requestedBy: { id, name }` on read. `DataTransfer.requestedById` is polymorphic
   * (`requestedByType` USER or DRIVER, see decisions.md D-092), so unlike `Report.requestedBy`
   * this is an app-level lookup rather than a Prisma relation. Batches by type across the
   * whole page so an N-row list never fires N lookups. */
  async resolveRequestedByMany(
    entries: Array<{ requestedById: string | null; requestedByType: 'USER' | 'DRIVER' | 'SYSTEM' }>,
  ): Promise<Map<string, { id: string; name: string }>> {
    const userIds = [...new Set(entries.filter((e) => e.requestedByType === 'USER' && e.requestedById).map((e) => e.requestedById as string))];
    const driverIds = [...new Set(entries.filter((e) => e.requestedByType === 'DRIVER' && e.requestedById).map((e) => e.requestedById as string))];
    const [users, drivers] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
      driverIds.length
        ? this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, firstName: true, lastName: true } })
        : [],
    ]);
    const byId = new Map<string, { id: string; name: string }>();
    for (const u of users) byId.set(u.id, { id: u.id, name: `${u.firstName} ${u.lastName}` });
    for (const d of drivers) byId.set(d.id, { id: d.id, name: `${d.firstName} ${d.lastName}` });
    return byId;
  }

  findCarrier(): Promise<Carrier | null> {
    return this.prisma.carrier.findFirst();
  }

  findDriver(driverId: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { id: driverId } });
  }

  /** Appendix A 4.8.2.2 — the 2-digit file sequence is "how many files today, plus one". */
  countTransfersInWindow(driverId: string, from: Date, to: Date): Promise<number> {
    return this.prisma.dataTransfer.count({
      where: { driverId, createdAt: { gte: from, lte: to } },
    });
  }

  createTransfer(data: Prisma.DataTransferCreateInput): Promise<DataTransfer> {
    return this.prisma.dataTransfer.create({ data });
  }

  findTransfer(id: string): Promise<DataTransfer | null> {
    return this.prisma.dataTransfer.findUnique({ where: { id } });
  }

  updateTransfer(id: string, data: Prisma.DataTransferUpdateInput): Promise<DataTransfer> {
    return this.prisma.dataTransfer.update({ where: { id }, data });
  }

  async listTransfers(where: Prisma.DataTransferWhereInput, page: number, limit: number) {
    const [items, total] = await Promise.all([
      this.prisma.dataTransfer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.dataTransfer.count({ where }),
    ]);
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  /**
   * EVERY §395 record for the driver in the window — active, superseded, proposed and
   * rejected alike. Appendix A requires the full audit trail, not the corrected picture.
   */
  findEvents(driverId: string, from: Date, to: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId, eventDateTime: { gte: from, lte: to } },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  }

  /** §395 unidentified driving: records with no driver attached (`recordOrigin = 4`). */
  findUnidentifiedEvents(from: Date, to: Date): Promise<EldEvent[]> {
    return this.prisma.eldEvent.findMany({
      where: { driverId: null, recordOrigin: 4, eventDateTime: { gte: from, lte: to } },
      orderBy: [{ eventDateTime: 'asc' }, { eventSequenceId: 'asc' }],
    });
  }

  findDailyLogs(driverId: string, from: Date, to: Date): Promise<DailyLog[]> {
    return this.prisma.dailyLog.findMany({
      where: { driverId, logDate: { gte: from, lte: to } },
      orderBy: { logDate: 'asc' },
    });
  }

  /** §10.3 — unresolved unidentified segments touching the window (warning, never blocking). */
  findPendingUnidentifiedSegments(from: Date, to: Date): Promise<UnidentifiedSegment[]> {
    return this.prisma.unidentifiedSegment.findMany({
      // B-83 — PENDING_CONFIRMATION is still unresolved: the records remain unidentified until the driver confirms.
      where: { status: { in: ['PENDING', 'PENDING_CONFIRMATION'] }, startAt: { lte: to }, endAt: { gte: from } },
    });
  }

  /** D-129 — trips that can overlap `[from, to]` (same query `GET /mobile/logs` uses). */
  findDayTrips(driverId: string, from: Date, to: Date): Promise<DayTrip[]> {
    return findDayTrips(this.prisma, driverId, from, to);
  }

  /** D-129 — the driver's no-trip day details for the RODS days `[fromDate, toDate]` (`@db.Date`). */
  findDayDetails(driverId: string, fromDate: Date, toDate: Date): Promise<DriverDayDetails[]> {
    return this.prisma.driverDayDetails.findMany({ where: { driverId, logDate: { gte: fromDate, lte: toDate } } });
  }

  findVehicles(ids: string[]): Promise<Vehicle[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.vehicle.findMany({ where: { id: { in: ids } } });
  }

  findUsers(ids: string[]): Promise<User[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.prisma.user.findMany({ where: { id: { in: ids } } });
  }
}
