import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { findAdverseInvokedToday } from '../drivers/lib/adverse-driving';
import type { LatestLocatedEvent, LatestTelemetry } from './live-fleet.mapper';

/**
 * LV-01 — first-pass lookback for the "latest row per vehicle" probes. A unit that reported in
 * the last two days (every unit on the road) is answered from the newest monthly partition(s);
 * only the rest pay for the unbounded probe. Changing it never changes the result, only the cost.
 */
export const RECENT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Reads for `GET /live/fleet`. Constant query count for the whole fleet (no N+1, tz.md §19):
 * one vehicle scan with its device + assigned driver, one LATERAL "latest fix per vehicle" on
 * `TelemetryPoint`, one on located `EldEvent`s (each + one fallback pass only for units silent
 * for 2 days, LV-01), one "latest status/PC-YM record per driver".
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

  /** BUG-001 — ids of the permitted drivers with adverse driving invoked for their current RODS day. */
  findAdverseInvokedToday(drivers: Array<{ id: string; homeTerminalTimezone: string; adverseDrivingEnabled: boolean }>, now: Date): Promise<Set<string>> {
    return findAdverseInvokedToday(this.prisma, drivers, now);
  }

  /**
   * Latest telemetry point per vehicle (speed / engine state), plus the latest point that carried
   * a GPS fix — PT SDK 6.11 points may have none, and a fix-less newest point must not blank the
   * map pin. Both probes ignore anything dated after `until` (device clock ahead).
   *
   * LV-01 — two passes with an identical result: first inside `[until - RECENT_WINDOW_MS, until]`,
   * which lets Postgres prune the monthly `TelemetryPoint` partitions to the current one or two
   * (an unbounded `ORDER BY time DESC LIMIT 1` probes EVERY partition, DEFAULT included, per
   * vehicle); then, only for the vehicles missing a row or a fix in that window, unbounded. The
   * fix probe rides `TelemetryPoint_vehicleId_time_fix_idx` (partial, fix rows only) instead of
   * walking — with a heap fetch per row — over every fix-less point of the vehicle.
   */
  async latestTelemetry(vehicleIds: string[], until: Date): Promise<Map<string, LatestTelemetry>> {
    if (!vehicleIds.length) return new Map();
    const since = new Date(until.getTime() - RECENT_WINDOW_MS);
    const recent = await this.telemetryProbe(vehicleIds, until, since);
    const result = new Map<string, LatestTelemetry>();
    for (const [vehicleId, row] of recent) if (row.fixTime) result.set(vehicleId, row);
    const missing = vehicleIds.filter((id) => !result.has(id));
    if (missing.length) for (const [vehicleId, row] of await this.telemetryProbe(missing, until, null)) result.set(vehicleId, row);
    return result;
  }

  private async telemetryProbe(vehicleIds: string[], until: Date, since: Date | null): Promise<Map<string, LatestTelemetry>> {
    const from = since ? Prisma.sql`AND "time" >= ${since}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<LatestTelemetry & { vehicleId: string }>>(Prisma.sql`
      SELECT v.id AS "vehicleId", t."time", p."time" AS "fixTime",
             p.latitude::float8 AS latitude, p.longitude::float8 AS longitude,
             t."speedMph", t."headingDeg", t."odometerMi", t."engineOn"
      FROM unnest(${vehicleIds}::text[]) AS v(id)
      CROSS JOIN LATERAL (
        SELECT "time", "speedMph", "headingDeg", "odometerMi", "engineOn"
        FROM "TelemetryPoint"
        WHERE "vehicleId" = v.id AND "time" <= ${until} ${from}
        ORDER BY "time" DESC
        LIMIT 1
      ) t
      LEFT JOIN LATERAL (
        SELECT "time", latitude, longitude
        FROM "TelemetryPoint"
        WHERE "vehicleId" = v.id AND "time" <= ${until} ${from} AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY "time" DESC
        LIMIT 1
      ) p ON true`);
    return new Map(rows.map(({ vehicleId, ...row }) => [vehicleId, row]));
  }

  /**
   * Latest active, located RODS record per vehicle — carries the §7 `locationName`. LV-01: same
   * recent-window-then-unbounded two passes as `latestTelemetry` (monthly `EldEvent` partitions).
   */
  async latestLocatedEvents(vehicleIds: string[], until: Date): Promise<Map<string, LatestLocatedEvent>> {
    if (!vehicleIds.length) return new Map();
    const result = await this.locatedProbe(vehicleIds, until, new Date(until.getTime() - RECENT_WINDOW_MS));
    const missing = vehicleIds.filter((id) => !result.has(id));
    if (missing.length) for (const [vehicleId, row] of await this.locatedProbe(missing, until, null)) result.set(vehicleId, row);
    return result;
  }

  private async locatedProbe(vehicleIds: string[], until: Date, since: Date | null): Promise<Map<string, LatestLocatedEvent>> {
    const from = since ? Prisma.sql`AND "eventDateTime" >= ${since}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<LatestLocatedEvent & { vehicleId: string }>>(Prisma.sql`
      SELECT v.id AS "vehicleId", e."eventDateTime", e.latitude::float8 AS latitude,
             e.longitude::float8 AS longitude, e."locationName"
      FROM unnest(${vehicleIds}::text[]) AS v(id)
      CROSS JOIN LATERAL (
        SELECT "eventDateTime", latitude, longitude, "locationName"
        FROM "EldEvent"
        WHERE "vehicleId" = v.id AND "recordStatus" = 1 AND latitude IS NOT NULL
          AND longitude IS NOT NULL AND "eventDateTime" <= ${until} ${from}
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
