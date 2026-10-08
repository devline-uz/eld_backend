import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Module } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { offsetMs } from '../hos/engine/timezone';
import { computeChecksum } from '../ingest/checksum';
import { EVENT_TYPE, LOGIN_CODE as LOGIN_EVENT_CODE, RECORD_ORIGIN, RECORD_STATUS } from '../ingest/event-codes';
import { IngestRepository, type IngestTx } from '../ingest/ingest.repository';

/** Appendix A 7.20 — eventType 5 codes. */
const LOGIN_CODE = LOGIN_EVENT_CODE.LOGIN;
const LOGOUT_CODE = LOGIN_EVENT_CODE.LOGOUT;

/** What made the server write the record — logged only (Appendix A has no field for it). */
export type LoginTrigger =
  | 'AUTH_LOGIN'
  | 'SELECT_VEHICLE'
  | 'CO_DRIVER_SWITCH'
  | 'AUTH_LOGOUT'
  | 'RELEASE_VEHICLE'
  | 'CO_DRIVER_LEAVE'
  | 'STALE_HOLDER_REPLACED';

/** How far back the unit's last odometer / engine-hours reading is looked up. */
const READING_LOOKBACK_MS = 7 * 86_400_000;

interface OpenLogin {
  vehicleId: string | null;
}

/**
 * D-130 — the server writes the §395 Appendix A 4.5.1.5 "driver's login/logout activity" records
 * (eventType 5: code 1 login, code 2 logout) itself; the app never sends them.
 *
 * - `recordOrigin = 1` (automatically recorded by the ELD), `recordStatus = 1`, per-driver
 *   `eventSequenceId` from the single allocator (`IngestRepository.allocateSequenceIds`), the
 *   driver's home-terminal offset, the unit's device, and the unit's last known odometer /
 *   engine hours / position (4.5.1.5(b)(6)-(7); 7.43 / 7.19 are mandatory for ELD-origin records).
 * - Idempotent under a per-driver advisory lock: no second login while one is open on the same
 *   unit; a login on ANOTHER unit first closes the open one with a logout; no logout without an
 *   open login. "Open" = the driver's latest ACTIVE eventType 5 record is a login — whoever wrote
 *   it (server or a device through ingest), so a device-sent login is never duplicated.
 * - Never throws: a failure is logged and the caller's authentication flow carries on (the driver
 *   must not be locked out of the ELD because an audit-trail write failed).
 *
 * Instantiates its own `IngestRepository` over the global `PrismaService` instead of importing
 * `IngestModule`: `AuthModule` needs this, and `IngestModule -> TelemetryModule -> DtcModule ->
 * VehiclesModule -> DriversModule -> AuthModule` would close a module cycle.
 */
@Injectable()
export class RodsLoginRecorder {
  private readonly logger = new Logger(RodsLoginRecorder.name);
  private readonly ingest: IngestRepository;

  constructor(private readonly prisma: PrismaService) {
    this.ingest = new IngestRepository(prisma);
  }

  /** Code 1 on `vehicleId` (closing an open login on another unit first). Returns rows written. */
  async login(driverId: string, vehicleId: string, trigger: LoginTrigger, at: Date = new Date()): Promise<number> {
    return this.guard(driverId, trigger, (open) => {
      if (open && open.vehicleId === vehicleId) return [];
      const rows: PlannedRow[] = [];
      // A logout 1 ms earlier keeps "latest record" ordering unambiguous even across a sequence wrap.
      if (open) rows.push({ code: LOGOUT_CODE, vehicleId: open.vehicleId, at: new Date(at.getTime() - 1) });
      rows.push({ code: LOGIN_CODE, vehicleId, at });
      return rows;
    });
  }

  /** Code 2 for the open login (only when it is on `onlyVehicleId`, if given). Returns rows written. */
  async logout(driverId: string, trigger: LoginTrigger, opts: { onlyVehicleId?: string } = {}, at: Date = new Date()): Promise<number> {
    return this.guard(driverId, trigger, (open) => {
      if (!open) return [];
      if (opts.onlyVehicleId && open.vehicleId !== opts.onlyVehicleId) return [];
      return [{ code: LOGOUT_CODE, vehicleId: open.vehicleId, at }];
    });
  }

  private async guard(
    driverId: string,
    trigger: LoginTrigger,
    plan: (open: OpenLogin | null) => PlannedRow[],
  ): Promise<number> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, `eldlogin:${driverId}`);
        const open = await this.findOpenLogin(tx, driverId);
        const rows = plan(open);
        if (!rows.length) return 0;
        await this.write(tx, driverId, rows);
        this.logger.log({ driverId, trigger, records: rows.map((r) => `${r.code}@${r.vehicleId ?? '-'}`) }, '§395 login/logout record(s) written');
        return rows.length;
      });
    } catch (err) {
      this.logger.error({ err, driverId, trigger }, 'Failed to write the §395 login/logout record');
      return 0;
    }
  }

  /** The driver's latest ACTIVE eventType 5 record, when it is a login. */
  private async findOpenLogin(tx: IngestTx, driverId: string): Promise<OpenLogin | null> {
    const last = await tx.eldEvent.findFirst({
      where: { driverId, eventType: EVENT_TYPE.LOGIN_LOGOUT, recordStatus: RECORD_STATUS.ACTIVE },
      orderBy: [{ eventDateTime: 'desc' }, { eventSequenceId: 'desc' }],
      select: { eventCode: true, vehicleId: true },
    });
    return last && last.eventCode === LOGIN_CODE ? { vehicleId: last.vehicleId } : null;
  }

  private async write(tx: IngestTx, driverId: string, rows: PlannedRow[]): Promise<void> {
    const driver = await tx.driver.findUnique({ where: { id: driverId }, select: { homeTerminalTimezone: true } });
    const timezone = driver?.homeTerminalTimezone ?? 'UTC';
    const sequenceIds = await this.ingest.allocateSequenceIds(tx, driverId, rows.length);
    await this.ingest.ensurePartitions(tx, [...new Set(rows.map((r) => monthOf(r.at)))]);

    const data: Prisma.EldEventCreateManyInput[] = [];
    for (const [index, row] of rows.entries()) {
      const unit = row.vehicleId ? await this.unitState(tx, row.vehicleId, row.at) : null;
      const base = {
        uuid: randomUUID(),
        eventType: EVENT_TYPE.LOGIN_LOGOUT,
        eventCode: row.code,
        eventDateTime: row.at,
        timezoneOffset: Math.round(offsetMs(timezone, row.at) / 60_000),
        recordStatus: RECORD_STATUS.ACTIVE,
        recordOrigin: RECORD_ORIGIN.ELD_AUTOMATIC,
        latitude: unit?.latitude ?? null,
        longitude: unit?.longitude ?? null,
        rawDeviceOdometerKm: null,
        totalEngineHours: unit?.totalEngineHours ?? null,
      };
      data.push({
        ...base,
        driverId,
        vehicleId: row.vehicleId,
        deviceId: unit?.deviceId ?? null,
        eventSequenceId: sequenceIds[index],
        locationPrecisionMi: unit?.locationPrecisionMi ?? 1,
        totalVehicleMiles: unit?.totalVehicleMiles ?? null,
        checksum: computeChecksum(base),
      });
    }
    await this.ingest.insertEvents(tx, data);
  }

  /** The unit's device and its last known odometer / engine hours / position at `at`. */
  private async unitState(tx: IngestTx, vehicleId: string, at: Date) {
    const [device, reading, vehicle] = await Promise.all([
      tx.device.findFirst({ where: { vehicleId }, select: { id: true } }),
      tx.eldEvent.findFirst({
        where: {
          vehicleId,
          recordStatus: RECORD_STATUS.ACTIVE,
          totalVehicleMiles: { not: null },
          eventDateTime: { gte: new Date(at.getTime() - READING_LOOKBACK_MS), lte: at },
        },
        orderBy: [{ eventDateTime: 'desc' }, { eventSequenceId: 'desc' }],
        select: { totalVehicleMiles: true, totalEngineHours: true, latitude: true, longitude: true, locationPrecisionMi: true },
      }),
      tx.vehicle.findUnique({ where: { id: vehicleId }, select: { odometerMi: true, engineHours: true } }),
    ]);
    const vehicleMiles = vehicle && vehicle.odometerMi > 0 ? vehicle.odometerMi : null;
    const vehicleHours = vehicle && Number(vehicle.engineHours) > 0 ? Number(vehicle.engineHours) : null;
    const hasFix = reading?.latitude != null && reading?.longitude != null;
    return {
      deviceId: device?.id ?? null,
      totalVehicleMiles: reading?.totalVehicleMiles ?? vehicleMiles,
      totalEngineHours: reading?.totalEngineHours != null ? Number(reading.totalEngineHours) : vehicleHours,
      latitude: hasFix ? Number(reading.latitude) : null,
      longitude: hasFix ? Number(reading.longitude) : null,
      locationPrecisionMi: hasFix ? reading.locationPrecisionMi : 1,
    };
  }
}

interface PlannedRow {
  code: typeof LOGIN_CODE | typeof LOGOUT_CODE;
  vehicleId: string | null;
  at: Date;
}

function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * D-130 — standalone on purpose (no imports): `AuthModule` and `MobileModule` both import it, and
 * `PrismaService` comes from the global `PrismaModule`.
 */
@Module({
  providers: [RodsLoginRecorder],
  exports: [RodsLoginRecorder],
})
export class RodsLoginModule {}
