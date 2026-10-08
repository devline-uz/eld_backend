import { Injectable } from '@nestjs/common';
import type {
  CoDriverPairing,
  Device,
  Driver,
  Dvir,
  Prisma,
  Role,
  Trailer,
  Trip,
  TripStop,
  User,
  Vehicle,
} from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export type VehicleWithDevice = Vehicle & { device: Device | null };
export type DvirWithDetail = Prisma.DvirGetPayload<{ include: { defects: { include: { photos: true } }; photos: true; trailer: { select: { number: true } } } }>;
export type StaffContact = Pick<User, 'id' | 'firstName' | 'lastName' | 'phone'> & { role: Pick<Role, 'key'> };

/**
 * TZ Phase 6b (tasks.md "Mobile API gaps") — MB-2/MB-3/MB-5/MB-10/MB-14 DB access.
 *
 * Kept out of `mobile.repository.ts` on purpose (Phase 6b shared-file list, `mobile/decisions.md`
 * MD-001): several other agents grow that file concurrently for unrelated gaps. Everything a
 * bootstrap/DVIR-submission path already needs (`findDriver`, `findVehicle`,
 * `findDeviceByVehicle`, `findActivePairing`, ...) is reused straight from `MobileRepository`
 * instead of being duplicated here.
 */
@Injectable()
export class MobileFleetOpsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------
  // MB-2 — vehicle selection (M-03)
  // ---------------------------------------------------------------------

  /** Vehicles assigned to `driverId`, or ACTIVE and not currently assigned to a *different*
   * ACTIVE driver — exactly the M-03 "select vehicle" list. */
  findAvailableVehicles(driverId: string, opts: { q?: string; limit?: number } = {}): Promise<VehicleWithDevice[]> {
    const q = opts.q?.trim();
    const and: Prisma.VehicleWhereInput[] = [
      {
        OR: [
          { driver: { id: driverId } },
          { status: 'ACTIVE', OR: [{ driver: null }, { driver: { status: { not: 'ACTIVE' } } }] },
        ],
      },
    ];
    if (q) {
      and.push({
        OR: [
          { unitNumber: { contains: q, mode: 'insensitive' } },
          { vin: { contains: q, mode: 'insensitive' } },
          { make: { contains: q, mode: 'insensitive' } },
          { model: { contains: q, mode: 'insensitive' } },
          { device: { is: { serial: { contains: q, mode: 'insensitive' } } } },
        ],
      });
    }
    return this.prisma.vehicle.findMany({
      where: { deletedAt: null, AND: and },
      include: { device: true },
      orderBy: { unitNumber: 'asc' },
      ...(opts.limit ? { take: opts.limit } : {}),
    });
  }

  /** MR-2 — clears the driver's unit and ends the active co-driver pairing on it (if any), atomically. */
  async releaseVehicle(driverId: string, pairingId: string | null, endedAt: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.driver.update({ where: { id: driverId }, data: { assignedVehicleId: null } });
      if (pairingId) {
        await tx.coDriverPairing.update({ where: { id: pairingId }, data: { endedAt, endedById: driverId } });
      }
    });
  }

  findVehicleWithDevice(vehicleId: string): Promise<VehicleWithDevice | null> {
    return this.prisma.vehicle.findUnique({ where: { id: vehicleId }, include: { device: true } });
  }

  /** The driver (any status) currently holding this unit — `Driver.assignedVehicleId` is
   * `@unique`, so at most one row ever matches. */
  findVehicleHolder(vehicleId: string): Promise<Driver | null> {
    return this.prisma.driver.findFirst({ where: { assignedVehicleId: vehicleId } });
  }

  /** Assigns `vehicleId` to `driverId`. If a non-ACTIVE driver still holds the unit (the
   * ACTIVE-holder case is rejected by the service with 409 before this is ever called), that
   * stale holder is cleared first so the `@unique` constraint on `assignedVehicleId` does not
   * reject the reassignment. */
  async assignVehicle(driverId: string, vehicleId: string, staleHolderId: string | null): Promise<Driver> {
    return this.prisma.$transaction(async (tx) => {
      if (staleHolderId) {
        await tx.driver.update({ where: { id: staleHolderId }, data: { assignedVehicleId: null } });
      }
      return tx.driver.update({ where: { id: driverId }, data: { assignedVehicleId: vehicleId } });
    });
  }

  // ---------------------------------------------------------------------
  // MB-3 — co-driver switch / leave (S-11/S-18/S-19)
  // ---------------------------------------------------------------------

  /** Latest active duty-status change (§5.5 `eventType` 1) for a driver — display-only, so a
   * single indexed read beats running the full HOS engine just to show a status chip. */
  async findLatestDutyStatus(driverId: string): Promise<'OFF' | 'SB' | 'D' | 'ON' | null> {
    const row = await this.prisma.eldEvent.findFirst({
      where: { driverId, eventType: 1, recordStatus: 1 },
      orderBy: [{ eventDateTime: 'desc' }, { eventSequenceId: 'desc' }],
      select: { eventCode: true },
    });
    if (!row) return null;
    const byCode: Record<number, 'OFF' | 'SB' | 'D' | 'ON'> = { 1: 'OFF', 2: 'SB', 3: 'D', 4: 'ON' };
    return byCode[row.eventCode] ?? null;
  }

  endPairing(pairingId: string, endedById: string, endedAt: Date): Promise<CoDriverPairing> {
    return this.prisma.coDriverPairing.update({ where: { id: pairingId }, data: { endedAt, endedById } });
  }

  createPairing(input: {
    primaryDriverId: string;
    coDriverId: string;
    vehicleId: string;
    startedAt: Date;
    startedById: string;
  }): Promise<CoDriverPairing> {
    return this.prisma.coDriverPairing.create({ data: input });
  }

  clearAssignedVehicle(driverId: string): Promise<Driver> {
    return this.prisma.driver.update({ where: { id: driverId }, data: { assignedVehicleId: null } });
  }

  // ---------------------------------------------------------------------
  // MB-5 — active trip (M-05/S-05/P-03)
  // ---------------------------------------------------------------------

  findActiveTrip(driverId: string): Promise<(Trip & { stops: TripStop[] }) | null> {
    return this.prisma.trip.findFirst({
      where: { driverId, status: 'IN_PROGRESS' },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });
  }

  findNextAssignedTrip(driverId: string): Promise<(Trip & { stops: TripStop[] }) | null> {
    return this.prisma.trip.findFirst({
      where: { driverId, status: 'ASSIGNED' },
      include: { stops: { orderBy: { sequence: 'asc' } } },
      orderBy: [{ plannedStartAt: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** All non-completed trips assigned to the driver — "documents" (BOL/shipping doc summary)
   * per §21 M-05/P-03: `DELIVERED`/`CANCELLED` are the only terminal `TripStatus` values. */
  findNonCompletedTrips(driverId: string): Promise<Trip[]> {
    return this.prisma.trip.findMany({
      where: { driverId, status: { notIn: ['DELIVERED', 'CANCELLED'] } },
      orderBy: [{ plannedStartAt: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** MR-4 — live trailers by exact number in ONE query (no per-number lookups). */
  findTrailersByNumbers(numbers: string[]): Promise<Trailer[]> {
    return this.prisma.trailer.findMany({ where: { number: { in: numbers }, deletedAt: null } });
  }

  findTrailerById(id: string): Promise<Trailer | null> {
    return this.prisma.trailer.findUnique({ where: { id } });
  }

  /** MR-8 — carrier's (single-tenant) live, ACTIVE trailers, optional number/VIN search. */
  listActiveTrailers(q: string | undefined, limit: number): Promise<Trailer[]> {
    const term = q?.trim();
    return this.prisma.trailer.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        ...(term ? { OR: [{ number: { contains: term, mode: 'insensitive' } }, { vin: { contains: term, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { number: 'asc' },
      take: limit,
    });
  }

  /** Live (not soft-deleted) trailer only — a deleted trailer cannot be put on a trip. */
  findTrailerByNumber(number: string): Promise<Trailer | null> {
    return this.prisma.trailer.findFirst({ where: { number, deletedAt: null } });
  }

  updateTrip(
    tripId: string,
    data: Prisma.TripUncheckedUpdateInput,
  ): Promise<Trip & { stops: TripStop[] }> {
    return this.prisma.trip.update({ where: { id: tripId }, data, include: { stops: { orderBy: { sequence: 'asc' } } } });
  }

  // ---------------------------------------------------------------------
  // MB-10 — own DVIR history (M-10/M-11/P-07)
  // ---------------------------------------------------------------------

  listOwnDvirs(driverId: string, since: Date): Promise<(Dvir & { _count: { defects: number }; trailer: { number: string } | null })[]> {
    return this.prisma.dvir.findMany({
      where: { driverId, submittedAt: { gte: since } },
      orderBy: { submittedAt: 'desc' },
      // MR-14 — `trailer.number` rides the same query (one join, no per-row lookup).
      include: { _count: { select: { defects: true } }, trailer: { select: { number: true } } },
    });
  }

  getOwnDvir(id: string, driverId: string): Promise<DvirWithDetail | null> {
    return this.prisma.dvir.findFirst({
      where: { id, driverId },
      include: { defects: { include: { photos: true } }, photos: true, trailer: { select: { number: true } } },
    });
  }

  // ---------------------------------------------------------------------
  // MB-14 — contacts (M-15/M-16)
  // ---------------------------------------------------------------------

  listStaffContacts(): Promise<StaffContact[]> {
    return this.prisma.user.findMany({
      where: { role: { key: { in: ['SUPER_ADMIN', 'ADMIN', 'FLEET_MANAGER', 'DISPATCHER'] } }, status: 'ACTIVE' },
      select: { id: true, firstName: true, lastName: true, phone: true, role: { select: { key: true } } },
      orderBy: [{ role: { key: 'asc' } }, { lastName: 'asc' }],
    });
  }
}
