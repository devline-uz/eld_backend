import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

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
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { username: { contains: q, mode: 'insensitive' } },
          { cdlNumber: { contains: q, mode: 'insensitive' } },
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
          { unitNumber: { contains: q, mode: 'insensitive' } },
          { vin: { contains: q, mode: 'insensitive' } },
          { make: { contains: q, mode: 'insensitive' } },
          { model: { contains: q, mode: 'insensitive' } },
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
