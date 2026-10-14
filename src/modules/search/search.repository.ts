import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { containsInsensitive } from '../../common/text/insensitive';

export interface SearchDriverRow {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  homeTerminalName: string;
  assignedVehicle: { unitNumber: string } | null;
}

export interface SearchVehicleRow {
  id: string;
  unitNumber: string;
  make: string | null;
  model: string | null;
  vin: string;
  driver: { firstName: string; lastName: string } | null;
}

@Injectable()
export class SearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  findDrivers(q: string, limit: number): Promise<SearchDriverRow[]> {
    return this.prisma.driver.findMany({
      where: {
        OR: [
          { firstName: containsInsensitive(q) },
          { lastName: containsInsensitive(q) },
          { username: containsInsensitive(q) },
          { cdlNumber: containsInsensitive(q) },
        ],
      },
      take: limit,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        homeTerminalName: true,
        assignedVehicle: { select: { unitNumber: true } },
      },
    });
  }

  findVehicles(q: string, limit: number): Promise<SearchVehicleRow[]> {
    return this.prisma.vehicle.findMany({
      where: {
        OR: [
          { unitNumber: containsInsensitive(q) },
          { vin: containsInsensitive(q) },
          { make: containsInsensitive(q) },
          { model: containsInsensitive(q) },
        ],
      },
      take: limit,
      select: {
        id: true,
        unitNumber: true,
        make: true,
        model: true,
        vin: true,
        driver: { select: { firstName: true, lastName: true } },
      },
    });
  }

  /** One grouped query for every matched driver's open-violation count — not one per row. */
  async openViolationCounts(driverIds: string[]): Promise<Map<string, number>> {
    if (!driverIds.length) return new Map();
    const rows = await this.prisma.hosViolation.groupBy({
      by: ['driverId'],
      where: { driverId: { in: driverIds }, status: 'OPEN' },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.driverId, r._count._all]));
  }

  scopeCounts(): Promise<{ units: number; drivers: number }> {
    return Promise.all([this.prisma.vehicle.count(), this.prisma.driver.count()]).then(([units, drivers]) => ({ units, drivers }));
  }
}
