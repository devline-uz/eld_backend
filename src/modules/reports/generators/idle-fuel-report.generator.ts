import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';
import type { IdleFuelReportParamsDto } from '../dto/reports.dto';
import { renderPdf } from '../lib/pdf-render';

export interface IdleFuelReportRow {
  vehicleId: string;
  unitNumber: string;
  driverId: string | null;
  driverName: string;
  date: string;
  idleHours: number;
  fuelIdleGal: number;
}

const PDF_ROW_CAP = 10_000;

/**
 * B-14 — `IDLE_FUEL`: idle time / fuel waste per vehicle per day, from `TelemetryPoint`
 * (TZ §5.6). `idleHours`/`totalFuelIdleGal` are cumulative engine-lifetime counters (same as
 * `odometerMi`), so a day's contribution is `MAX(value) - MIN(value)` over that day's points —
 * never a raw per-point read, which would double count. Reads `TelemetryPoint` directly (never
 * `IftaSegment`): retention keeps telemetry only 13 months, but idle/fuel-waste reporting is
 * an operational report, not a 4-year compliance audit trail like IFTA (TZ §15/§19), so it is
 * fine for this report to age out with the raw telemetry.
 */
@Injectable()
export class IdleFuelReportGenerator {
  constructor(private readonly prisma: PrismaService) {}

  async rows(params: IdleFuelReportParamsDto): Promise<IdleFuelReportRow[]> {
    const from = new Date(`${params.from}T00:00:00.000Z`);
    const to = new Date(`${params.to}T23:59:59.999Z`);

    const clauses: Prisma.Sql[] = [Prisma.sql`t."time" >= ${from} AND t."time" <= ${to}`];
    if (params.vehicleId) clauses.push(Prisma.sql`t."vehicleId" = ${params.vehicleId}`);
    if (params.driverId) clauses.push(Prisma.sql`t."driverId" = ${params.driverId}`);

    const rows = await this.prisma.$queryRaw<
      Array<{
        vehicleId: string;
        unitNumber: string;
        driverId: string | null;
        day: Date;
        idleDeltaHours: number | null;
        fuelIdleDeltaGal: number | null;
      }>
    >(Prisma.sql`
      SELECT
        t."vehicleId" AS "vehicleId",
        v."unitNumber" AS "unitNumber",
        MAX(t."driverId") AS "driverId",
        date_trunc('day', t."time") AS "day",
        MAX(t."idleHours") - MIN(t."idleHours") AS "idleDeltaHours",
        MAX(t."totalFuelIdleGal") - MIN(t."totalFuelIdleGal") AS "fuelIdleDeltaGal"
      FROM "TelemetryPoint" t
      JOIN "Vehicle" v ON v."id" = t."vehicleId"
      WHERE ${Prisma.join(clauses, ' AND ')}
      GROUP BY t."vehicleId", v."unitNumber", date_trunc('day', t."time")
      ORDER BY "unitNumber" ASC, "day" ASC
    `);

    if (rows.length === 0) return [];

    const driverIds = [...new Set(rows.map((r) => r.driverId).filter((v): v is string => Boolean(v)))];
    const drivers = driverIds.length
      ? await this.prisma.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const driverNameById = new Map(drivers.map((d) => [d.id, `${d.lastName}, ${d.firstName}`]));

    return rows.map((r) => ({
      vehicleId: r.vehicleId,
      unitNumber: r.unitNumber,
      driverId: r.driverId,
      driverName: r.driverId ? driverNameById.get(r.driverId) ?? r.driverId : '—',
      date: r.day.toISOString().slice(0, 10),
      idleHours: Math.max(0, Number(r.idleDeltaHours ?? 0)),
      fuelIdleGal: Math.max(0, Number(r.fuelIdleDeltaGal ?? 0)),
    }));
  }

  async pdf(params: IdleFuelReportParamsDto): Promise<{ pdf: Buffer; rowCount: number }> {
    const allRows = await this.rows(params);
    const rows = allRows.slice(0, PDF_ROW_CAP).map((r) => ({ ...r, idleHours: r.idleHours.toFixed(2), fuelIdleGal: r.fuelIdleGal.toFixed(2) }));
    const totalIdleHours = allRows.reduce((s, r) => s + r.idleHours, 0).toFixed(2);
    const totalFuelIdleGal = allRows.reduce((s, r) => s + r.fuelIdleGal, 0).toFixed(2);
    const pdf = await renderPdf('idle-fuel-report', { from: params.from, to: params.to, totalIdleHours, totalFuelIdleGal, rows });
    return { pdf, rowCount: rows.length };
  }
}
