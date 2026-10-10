import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import type { LatestLocatedEvent, LatestTelemetry } from './live-fleet.mapper';

/**
 * Reads for `GET /live/fleet`. Constant query count for the whole fleet (no N+1, tz.md §19):
 * one vehicle scan with its device + assigned driver, one LATERAL "latest fix per vehicle" on
 * `TelemetryPoint`, one on located `EldEvent`s, one "latest status/PC-YM record per driver".
 * The LATERAL `LIMIT 1` probes ride the `(vehicleId, time)` / `(vehicleId, eventDateTime)` indexes.
 */
@Injectable()
export class LiveFleetRepository {
  constructor(private readonly prisma: PrismaService) {}

  findVehicles() {
    return this.prisma.vehicle.findMany({
      // A deleted unit (`DELETE /vehicles/:id` sets `deletedAt`) is hidden from every web read —
      // Live Fleet and the Dashboard KPIs used to keep listing it as an "Inactive" unit.
      where: { deletedAt: null },
      orderBy: { unitNumber: 'asc' },
      select: {
        id: true,
        unitNumber: true,
        status: true,
        odometerMi: true,
        device: { select: { serial: true, bleState: true, lastSeenAt: true } },
        // Full row: `HosRecalcService.computeCurrentStates` needs the driver's HOS config.
        driver: true,
      },
    });
  }

  /**
   * Latest telemetry point per vehicle (speed / engine state), plus the latest point that carried
   * a GPS fix — PT SDK 6.11 points may have none, and a fix-less newest point must not blank the
   * map pin. Both probes ignore anything dated after `until` (device clock ahead).
   */
  async latestTelemetry(vehicleIds: string[], until: Date): Promise<Map<string, LatestTelemetry>> {
    if (!vehicleIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<LatestTelemetry & { vehicleId: string }>>(Prisma.sql`
      SELECT v.id AS "vehicleId", t."time", p."time" AS "fixTime",
             p.latitude::float8 AS latitude, p.longitude::float8 AS longitude,
             t."speedMph", t."headingDeg", t."odometerMi", t."engineOn"
      FROM unnest(${vehicleIds}::text[]) AS v(id)
      CROSS JOIN LATERAL (
        SELECT "time", "speedMph", "headingDeg", "odometerMi", "engineOn"
        FROM "TelemetryPoint"
        WHERE "vehicleId" = v.id AND "time" <= ${until}
        ORDER BY "time" DESC
        LIMIT 1
      ) t
      LEFT JOIN LATERAL (
        SELECT "time", latitude, longitude
        FROM "TelemetryPoint"
        WHERE "vehicleId" = v.id AND "time" <= ${until} AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY "time" DESC
        LIMIT 1
      ) p ON true`);
    return new Map(rows.map(({ vehicleId, ...row }) => [vehicleId, row]));
  }

  /** Latest active, located RODS record per vehicle — carries the §7 `locationName`. */
  async latestLocatedEvents(vehicleIds: string[], until: Date): Promise<Map<string, LatestLocatedEvent>> {
    if (!vehicleIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<LatestLocatedEvent & { vehicleId: string }>>(Prisma.sql`
      SELECT v.id AS "vehicleId", e."eventDateTime", e.latitude::float8 AS latitude,
             e.longitude::float8 AS longitude, e."locationName"
      FROM unnest(${vehicleIds}::text[]) AS v(id)
      CROSS JOIN LATERAL (
        SELECT "eventDateTime", latitude, longitude, "locationName"
        FROM "EldEvent"
        WHERE "vehicleId" = v.id AND "recordStatus" = 1 AND latitude IS NOT NULL
          AND longitude IS NOT NULL AND "eventDateTime" <= ${until}
        ORDER BY "eventDateTime" DESC
        LIMIT 1
      ) e`);
    return new Map(rows.map(({ vehicleId, ...row }) => [vehicleId, row]));
  }

  /**
   * Active PC/YM indication per driver: the newest eventType 3 record, kept only when it is not
   * older than the newest duty-status record (a later status change supersedes it, §7.3 rule 9).
   */
  async activeSpecialDriving(driverIds: string[], from: Date, until: Date): Promise<Map<string, 'PC' | 'YM'>> {
    const result = new Map<string, 'PC' | 'YM'>();
    if (!driverIds.length) return result;
    const rows = await this.prisma.$queryRaw<
      Array<{ driverId: string; eventType: number; eventCode: number; eventDateTime: Date }>
    >(Prisma.sql`
      SELECT DISTINCT ON ("driverId", "eventType") "driverId", "eventType", "eventCode", "eventDateTime"
      FROM "EldEvent"
      WHERE "driverId" = ANY(${driverIds}::text[]) AND "eventType" IN (1, 3) AND "recordStatus" = 1
        AND "eventDateTime" >= ${from} AND "eventDateTime" <= ${until}
      ORDER BY "driverId", "eventType", "eventDateTime" DESC, "eventSequenceId" DESC`);
    const byDriver = new Map<string, { status?: Date; special?: { code: number; at: Date } }>();
    for (const row of rows) {
      const entry = byDriver.get(row.driverId) ?? {};
      if (row.eventType === 1) entry.status = row.eventDateTime;
      else entry.special = { code: row.eventCode, at: row.eventDateTime };
      byDriver.set(row.driverId, entry);
    }
    for (const [driverId, { status, special }] of byDriver) {
      if (!special || (status && status.getTime() > special.at.getTime())) continue;
      if (special.code === 1) result.set(driverId, 'PC');
      else if (special.code === 2) result.set(driverId, 'YM');
    }
    return result;
  }
}
