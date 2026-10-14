import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { containsInsensitive, equalsInsensitive } from '../../common/text/insensitive';
import { normalizeUnitQuery, searchTokens } from './search-ranking';

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

const VEHICLE_SELECT = {
  id: true,
  unitNumber: true,
  make: true,
  model: true,
  vin: true,
  driver: { select: { firstName: true, lastName: true } },
} as const;

@Injectable()
export class SearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * LIVE-009 — every word of `q` must match a name column, so "Richard Lewis" (first + last) and
   * "QA Dri" (first + start of last) find the driver; a single word behaves as before.
   * Soft-deleted drivers are never offered.
   */
  findDrivers(q: string, take: number): Promise<SearchDriverRow[]> {
    const tokens = searchTokens(q);
    return this.prisma.driver.findMany({
      where: {
        deletedAt: null,
        AND: tokens.map((token) => ({
          OR: [
            { firstName: containsInsensitive(token) },
            { lastName: containsInsensitive(token) },
            { username: containsInsensitive(token) },
            { cdlNumber: containsInsensitive(token) },
          ],
        })),
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take,
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

  /**
   * LIVE-009 — the exact unit (`106`, `#106`) or VIN is loaded on its own, so a substring match
   * on many other units (161, 165, 1060…) can never push it out of the candidate set.
   */
  async findVehicles(q: string, take: number): Promise<SearchVehicleRow[]> {
    const term = q.trim();
    const unit = normalizeUnitQuery(term) || term;
    const [exact, partial] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: {
          deletedAt: null,
          OR: [
            { unitNumber: equalsInsensitive(unit) },
            { unitNumber: equalsInsensitive(`#${unit}`) },
            { vin: equalsInsensitive(term) },
          ],
        },
        take,
        select: VEHICLE_SELECT,
      }),
      this.prisma.vehicle.findMany({
        where: {
          deletedAt: null,
          OR: [
            { unitNumber: containsInsensitive(unit) },
            { vin: containsInsensitive(term) },
            { make: containsInsensitive(term) },
            { model: containsInsensitive(term) },
          ],
        },
        orderBy: { unitNumber: 'asc' },
        take,
        select: VEHICLE_SELECT,
      }),
    ]);
    const seen = new Set<string>();
    return [...exact, ...partial].filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
  }

  scopeCounts(): Promise<{ units: number; drivers: number }> {
    return Promise.all([
      this.prisma.vehicle.count({ where: { deletedAt: null } }),
      this.prisma.driver.count({ where: { deletedAt: null } }),
    ]).then(([units, drivers]) => ({ units, drivers }));
  }
}
