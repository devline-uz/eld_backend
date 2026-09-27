import { Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { Prisma, Vehicle } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { applyOdometerOffsetMi, computeOdometerOffsetMi } from '../../common/units/odometer';
import { CarrierRepository } from '../carrier/carrier.repository';
import { DriversRepository } from '../drivers/drivers.repository';
import { FirebaseService } from '../../core/firebase/firebase.service';
import { MobileRepository } from '../mobile/mobile.repository';
import { NotificationsRepository } from '../notifications/notifications.repository';
import { MAIL_PORT, MailPort } from '../transfers/mail.port';
import { UsersRepository } from '../users/users.repository';
import { buildVehicleHistories, HistoryPoint, VehicleHistoriesResponse } from './lib/vehicle-histories';
import {
  AssignDriverDto,
  BulkUpdateVehicleStatusDto,
  CalibrateOdometerDto,
  CreateVehicleDto,
  ImportVehicleRowDto,
  ImportVehiclesDto,
  ImportVehiclesOptionsDto,
  UpdateVehicleDto,
  VehicleListQueryDto,
  VehicleTelemetryQueryDto,
} from './dto/vehicles.dto';
import { VehiclesRepository } from './vehicles.repository';

const SORTABLE_FIELDS = ['unitNumber', 'vin', 'make', 'model', 'status', 'createdAt'] as const;

const DEFAULT_IMPORT_OPTIONS: ImportVehiclesOptionsDto = {
  duplicateStrategy: 'UPDATE_BY_VIN',
  pairDevices: false,
  emailSummary: false,
};

/** Prisma unique-constraint violation (`P2002`) — here only the live-row partial unique indexes on
 * `unitNumber` / `vin` can raise it (a concurrent create/update racing the pre-check). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/** Which column the `P2002` names — `meta.target` is the field list or the index name. */
function uniqueViolationTarget(err: unknown): string {
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.join(',');
  return typeof target === 'string' ? target : '';
}

export interface ImportSummary {
  imported: number;
  updated: number;
  skipped?: number;
  failed: Array<{ index: number; error: string }>;
}

export interface VehicleActivityItem {
  id: string;
  occurredAt: string;
  activity: string;
  driverName: string | null;
  source: string;
  details: string;
}

export interface BulkStatusResult {
  updated: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * TZ §5.3 / §4.3 — vehicle (unit) CRUD plus the odometer calibration flow. Driver assignment
 * lives here (not on `DriversController`) because the out-of-service block (hard rule: a
 * `Vehicle.status = OUT_OF_SERVICE` refuses assignment) is a *vehicle* invariant; this keeps
 * the module dependency one-directional (Vehicles -> Drivers, never the reverse).
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly vehicles: VehiclesRepository,
    private readonly drivers: DriversRepository,
    private readonly notifications: NotificationsRepository,
    private readonly carrier: CarrierRepository,
    private readonly users: UsersRepository,
    private readonly mobile: MobileRepository,
    private readonly firebase: FirebaseService,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
  ) {}

  async list(query: VehicleListQueryDto): Promise<OffsetPage<Vehicle>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { unitNumber: 'asc' });
    const { items, total } = await this.vehicles.list({ status: query.status, q: query.q, groupId: query.groupId }, query.page, query.limit, orderBy);
    return toOffsetPage(items, total, query.page, query.limit);
  }

  async get(id: string): Promise<Vehicle> {
    const vehicle = await this.vehicles.findById({ id });
    // Soft-deleted units are gone as far as the web is concerned.
    if (!vehicle || vehicle.deletedAt) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404);
    return vehicle;
  }

  async create(dto: CreateVehicleDto): Promise<Vehicle> {
    const [byUnit, byVin] = await Promise.all([
      this.vehicles.findByUnitNumber(dto.unitNumber),
      this.vehicles.findByVin(dto.vin),
    ]);
    if (byUnit) throw AppException.conflict(`Unit "${dto.unitNumber}" already exists.`);
    if (byVin) throw AppException.conflict(`VIN "${dto.vin}" already exists.`);
    await this.assertGroupExists(dto.groupId);
    return this.conflictOnDuplicate(this.vehicles.create(this.toCreateInput(dto)), dto);
  }

  async update(id: string, dto: UpdateVehicleDto): Promise<Vehicle> {
    await this.get(id);
    await this.assertUnitAndVinAvailable(dto, id);
    await this.assertStatusChangeAllowed(id, dto.status);
    await this.assertGroupExists(dto.groupId);
    return this.conflictOnDuplicate(this.vehicles.update({ id }, this.toUpdateInput(dto)), dto);
  }

  /** Unit number / VIN are unique among LIVE units only — a soft-deleted unit's values are free.
   * `exceptVehicleId` lets a unit keep (re-send) its own values on update. */
  private async assertUnitAndVinAvailable(
    dto: { unitNumber?: string; vin?: string },
    exceptVehicleId?: string,
  ): Promise<void> {
    const [byUnit, byVin] = await Promise.all([
      dto.unitNumber !== undefined ? this.vehicles.findByUnitNumber(dto.unitNumber) : null,
      dto.vin !== undefined ? this.vehicles.findByVin(dto.vin) : null,
    ]);
    if (byUnit && byUnit.id !== exceptVehicleId) throw AppException.conflict(`Unit "${dto.unitNumber}" already exists.`);
    if (byVin && byVin.id !== exceptVehicleId) throw AppException.conflict(`VIN "${dto.vin}" already exists.`);
  }

  /** A write that loses a race to the pre-check hits the partial unique index (`P2002`); surface
   * it as the same 409 the pre-check would have thrown, never a raw 500. */
  private async conflictOnDuplicate<T>(write: Promise<T>, dto: { unitNumber?: string; vin?: string }): Promise<T> {
    try {
      return await write;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const target = uniqueViolationTarget(err);
      if (target.includes('vin')) throw AppException.conflict(`VIN "${dto.vin}" already exists.`);
      if (target.includes('unitNumber')) throw AppException.conflict(`Unit "${dto.unitNumber}" already exists.`);
      throw AppException.conflict('A vehicle with this unit number or VIN already exists.');
    }
  }

  /**
   * TZ §5.10 hard rule — an OPEN + CRITICAL defect forces `Vehicle.status = OUT_OF_SERVICE` and
   * keeps it there; nothing may move the unit to a non-OOS status while one remains open. Covers
   * every caller of `toUpdateInput` (plain update, bulk import) so a `PATCH /vehicles/:id
   * { status: 'ACTIVE' }` can't silently undo what `MobileDvirService` / `DefectsService` enforce
   * (see bugs.md — unit 101 regression). Bug: B-063. Decision: D-034.
   */
  private async assertStatusChangeAllowed(vehicleId: string, nextStatus: UpdateVehicleDto['status']): Promise<void> {
    if (nextStatus === undefined || nextStatus === 'OUT_OF_SERVICE') return;
    const blocking = await this.vehicles.findOpenCriticalDefectIds(vehicleId);
    if (blocking.length === 0) return;
    throw new AppException(
      ERROR_CODES.VEHICLE_HAS_OPEN_CRITICAL_DEFECTS,
      'Vehicle has open critical defects and cannot leave OUT_OF_SERVICE status.',
      409,
      { vehicleId, blockingDefectIds: blocking.map((d) => d.id) },
    );
  }

  /**
   * Soft-delete only (never a hard `DELETE`) — see bugs.md B-009: Postgres's FK
   * `ON DELETE SET NULL` from `EldEvent` needs `UPDATE` on `EldEvent`, which the append-only
   * hardening migration revokes fleet-wide. A plain `status` flip never touches `EldEvent` and
   * is also the correct behavior on its own merits: a unit with historical ELD events must
   * never be dropped from the fleet table. `deletedAt` hides the row from every web read and frees
   * its unit number / VIN for a new unit (partial unique indexes cover live rows only).
   */
  async remove(id: string): Promise<Vehicle> {
    await this.get(id);
    await this.assertStatusChangeAllowed(id, 'INACTIVE');
    const driver = await this.drivers.findOne({ assignedVehicleId: id });
    if (driver) await this.drivers.update({ id: driver.id }, { assignedVehicle: { disconnect: true } });
    return this.vehicles.update({ id }, { status: 'INACTIVE', deletedAt: new Date() });
  }

  /**
   * TZ §4.3 step 4 — recalibration. `dto.odometerMi` is the true dash value the user just
   * read; the offset is only recomputed once a device reading exists to calibrate against
   * (`deviceOdometerMi`) — before that, the first PT30 event does the initial calibration
   * (ingest, Phase 3). Always audited via `@Audit` on the controller (hard rule).
   */
  async calibrateOdometer(id: string, dto: CalibrateOdometerDto): Promise<Vehicle> {
    const vehicle = await this.get(id);
    if (vehicle.deviceOdometerMi == null) {
      // No device reading yet to calibrate against — just record the dash value.
      return this.vehicles.update({ id }, { odometerMi: dto.odometerMi });
    }
    const odometerOffsetMi = computeOdometerOffsetMi({
      odometerMi: dto.odometerMi,
      deviceOdometerMi: vehicle.deviceOdometerMi,
    });
    return this.vehicles.update(
      { id },
      { odometerMi: dto.odometerMi, odometerOffsetMi, odometerCalibratedAt: new Date() },
    );
  }

  /** Convenience read matching the formula in TZ §4.3: `true = device + offset`. */
  trueOdometerMi(vehicle: Vehicle): number | null {
    if (vehicle.deviceOdometerMi == null) return vehicle.odometerMi;
    return applyOdometerOffsetMi(vehicle.deviceOdometerMi, vehicle.odometerOffsetMi);
  }

  /** Hard rule — an `OUT_OF_SERVICE` unit blocks driver assignment. §20 B-74 — `notify`
   * (default true) fires the existing driver-app notification (in-app inbox row picked up by
   * `GET /notifications`, same table `NotificationsController` already reads). */
  async assignDriver(vehicleId: string, dto: AssignDriverDto): Promise<Vehicle> {
    const vehicle = await this.get(vehicleId);
    if (vehicle.status === 'OUT_OF_SERVICE') {
      throw new AppException(ERROR_CODES.VEHICLE_OUT_OF_SERVICE, 'Vehicle is out of service and cannot be assigned a driver.', 409);
    }
    const driver = await this.drivers.findById({ id: dto.driverId });
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    if (driver.assignedVehicleId === vehicleId) return vehicle;
    try {
      await this.drivers.update({ id: dto.driverId }, { assignedVehicle: { connect: { id: vehicleId } } });
    } catch {
      throw AppException.conflict('Vehicle is already assigned to another driver.');
    }
    if (dto.notify) {
      const title = 'New unit assignment';
      const body = `You've been assigned to unit ${vehicle.unitNumber}.`;
      const notification = await this.notifications.create({
        driverId: dto.driverId,
        type: 'ASSIGNMENT',
        title,
        body,
        objectType: 'Vehicle',
        objectId: vehicleId,
        category: 'assignment',
      });
      // §12.7 — background app gets FCM too, not just the in-app inbox row (same
      // IN_APP + FCM pairing `AlertProcessor.send` uses for every other driver alert).
      if (this.firebase.enabled) {
        const tokens = await this.mobile.findPushTokens(dto.driverId);
        await Promise.allSettled(
          tokens.map((t) =>
            this.firebase.sendToToken(
              t.token,
              { title, body },
              { type: 'ASSIGNMENT', id: notification.id, driverId: dto.driverId },
            ),
          ),
        );
      }
    }
    return vehicle;
  }

  async unassignDriver(vehicleId: string): Promise<Vehicle> {
    const vehicle = await this.get(vehicleId);
    const driver = await this.drivers.findOne({ assignedVehicleId: vehicleId });
    if (driver) await this.drivers.update({ id: driver.id }, { assignedVehicle: { disconnect: true } });
    return vehicle;
  }

  /** §20 B-71 — `PATCH /vehicles/bulk-status`, one row at a time so a single bad id doesn't
   * fail the whole batch; each row still goes through the OOS hard rule. */
  async bulkUpdateStatus(dto: BulkUpdateVehicleStatusDto): Promise<BulkStatusResult> {
    const result: BulkStatusResult = { updated: [], failed: [] };
    for (const id of dto.ids) {
      try {
        await this.get(id);
        await this.assertStatusChangeAllowed(id, dto.status);
        await this.vehicles.update({ id }, { status: dto.status });
        result.updated.push(id);
      } catch (err) {
        result.failed.push({ id, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------
  // §20 B-5 — "Unit activity" feed.
  // -------------------------------------------------------------------

  async activities(vehicleId: string): Promise<VehicleActivityItem[]> {
    await this.get(vehicleId);
    const [auditRows, dvirRows] = await Promise.all([
      this.vehicles.findAuditRows(vehicleId),
      this.vehicles.findDvirRows(vehicleId),
    ]);
    const driverActorIds = [...new Set(auditRows.filter((r) => r.actorType === 'DRIVER').map((r) => r.actorId))];
    const driverNames = new Map<string, string>();
    if (driverActorIds.length > 0) {
      const found = await Promise.all(driverActorIds.map((id) => this.drivers.findById({ id })));
      found.forEach((d, i) => {
        if (d) driverNames.set(driverActorIds[i], `${d.firstName} ${d.lastName}`);
      });
    }
    const fromAudit: VehicleActivityItem[] = auditRows.map((row) => ({
      id: `audit_${row.id}`,
      occurredAt: row.createdAt.toISOString(),
      activity: row.action,
      driverName: row.actorType === 'DRIVER' ? driverNames.get(row.actorId) ?? null : null,
      source: 'AUDIT',
      details: row.detail ?? JSON.stringify(row.after ?? row.before ?? {}),
    }));
    const fromDvir: VehicleActivityItem[] = dvirRows.map((row) => ({
      id: `dvir_${row.id}`,
      occurredAt: row.submittedAt.toISOString(),
      activity: `DVIR_${row.type}`,
      driverName: `${row.driver.firstName} ${row.driver.lastName}`,
      source: 'DVIR',
      details: row.notes ? `${row.vehicleCondition} — ${row.notes}` : row.vehicleCondition,
    }));
    return [...fromAudit, ...fromDvir].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  }

  // -------------------------------------------------------------------
  // §20 B-4 — `GET /vehicles/:id/histories?date=`, server-side day segmentation.
  // -------------------------------------------------------------------

  async histories(vehicleId: string, date: string): Promise<VehicleHistoriesResponse> {
    const vehicle = await this.get(vehicleId);
    const driver = await this.drivers.findOne({ assignedVehicleId: vehicleId });
    const tz = await this.dayBoundaryTimezone(driver?.homeTerminalTimezone);

    const dayStart = DateTime.fromISO(date, { zone: tz }).startOf('day');
    if (!dayStart.isValid) throw AppException.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Invalid date.');
    const dayEnd = dayStart.plus({ days: 1 });

    const points = await this.vehicles.findTelemetryRange(vehicle.id, dayStart.toUTC().toJSDate(), dayEnd.toUTC().toJSDate());
    const historyPoints: HistoryPoint[] = points.map((p) => ({
      time: p.time,
      speedMph: p.speedMph,
      engineOn: p.engineOn,
      odometerMi: p.odometerMi,
      totalFuelIdleGal: p.totalFuelIdleGal ? Number(p.totalFuelIdleGal) : null,
      driverId: p.driverId,
      lat: Number(p.latitude),
      lon: Number(p.longitude),
    }));

    const driverIds = [...new Set(historyPoints.map((p) => p.driverId).filter((id): id is string => Boolean(id)))];
    const driverNameById = new Map<string, string>();
    if (driverIds.length > 0) {
      const found = await Promise.all(driverIds.map((id) => this.drivers.findById({ id })));
      found.forEach((d, i) => {
        if (d) driverNameById.set(driverIds[i], `${d.firstName} ${d.lastName}`);
      });
    }

    return buildVehicleHistories(date, historyPoints, driverNameById);
  }

  private async dayBoundaryTimezone(driverTz: string | undefined): Promise<string> {
    if (driverTz) return driverTz;
    const carrier = await this.carrier.get();
    return carrier?.timezone ?? 'America/New_York';
  }

  // -------------------------------------------------------------------
  // Telemetry read path — `GET /vehicles/:id/telemetry`.
  // -------------------------------------------------------------------

  async telemetryRecent(vehicleId: string, query: VehicleTelemetryQueryDto) {
    await this.get(vehicleId);
    return this.vehicles.findTelemetryRecent(vehicleId, query.limit, query.from, query.to);
  }

  async exportAll(): Promise<CreateVehicleDto[]> {
    return (await this.vehicles.listAll()).map((v) => this.toExportRow(v));
  }

  /**
   * §20 B-69 — `options` change the result for real: `duplicateStrategy` picks UPDATE_BY_VIN
   * (prior behavior) / SKIP / CREATE, `defaultTerminal` backfills `notes` when a row omits it
   * (`Vehicle` has no dedicated terminal column), `pairDevices` pairs a row's `deviceSerial` to
   * the created/updated unit, `emailSummary` emails the import result to the calling user.
   */
  async importMany(dto: ImportVehiclesDto, actorUserId?: string): Promise<ImportSummary> {
    const options = dto.options ?? DEFAULT_IMPORT_OPTIONS;
    const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, failed: [] };
    for (let index = 0; index < dto.vehicles.length; index += 1) {
      const row = this.applyImportDefaults(dto.vehicles[index], options);
      try {
        await this.assertGroupExists(row.groupId);
        const existing = (await this.vehicles.findByUnitNumber(row.unitNumber)) ?? (await this.vehicles.findByVin(row.vin));
        let vehicle: Vehicle;
        if (existing) {
          if (options.duplicateStrategy === 'SKIP') {
            summary.skipped = (summary.skipped ?? 0) + 1;
            continue;
          }
          if (options.duplicateStrategy === 'CREATE') {
            summary.failed.push({ index, error: `Unit "${row.unitNumber}" / VIN "${row.vin}" already exists.` });
            continue;
          }
          await this.assertUnitAndVinAvailable(row, existing.id);
          await this.assertStatusChangeAllowed(existing.id, (row as UpdateVehicleDto).status);
          vehicle = await this.conflictOnDuplicate(this.vehicles.update({ id: existing.id }, this.toUpdateInput(row)), row);
          summary.updated += 1;
        } else {
          vehicle = await this.conflictOnDuplicate(this.vehicles.create(this.toCreateInput(row)), row);
          summary.imported += 1;
        }
        if (options.pairDevices && row.deviceSerial) {
          await this.pairDeviceQuietly(row.deviceSerial, vehicle.id);
        }
      } catch (err) {
        summary.failed.push({ index, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    if (options.emailSummary && actorUserId) {
      await this.emailImportSummary(actorUserId, summary);
    }
    return summary;
  }

  private applyImportDefaults(row: ImportVehicleRowDto, options: ImportVehiclesOptionsDto): ImportVehicleRowDto {
    if (!options.defaultTerminal || row.notes) return row;
    return { ...row, notes: `Terminal: ${options.defaultTerminal}` };
  }

  /** A bad `deviceSerial` in an import row must never fail the whole vehicle row — it is a
   * best-effort convenience on top of an already-succeeded create/update. */
  private async pairDeviceQuietly(serial: string, vehicleId: string): Promise<void> {
    const device = await this.vehicles.findDeviceBySerial(serial);
    if (!device || device.vehicleId) return;
    await this.vehicles.pairDevice(device.id, vehicleId);
  }

  private async emailImportSummary(actorUserId: string, summary: ImportSummary): Promise<void> {
    const user = await this.users.findById({ id: actorUserId });
    if (!user?.email) return;
    // Reuses the same `MAIL_PORT`-backed transport as reports/eRODS (TZ §10.4) — Phase 1's
    // default provider logs and does not deliver; see `mail.port.ts`.
    await this.mail.send({
      to: user.email,
      subject: 'Vehicle import summary',
      text: `Imported ${summary.imported}, updated ${summary.updated}, skipped ${summary.skipped ?? 0}, failed ${summary.failed.length}.`,
      attachments: [],
    });
  }

  private toCreateInput(dto: CreateVehicleDto): Prisma.VehicleCreateInput {
    return {
      unitNumber: dto.unitNumber,
      vin: dto.vin,
      make: dto.make,
      model: dto.model,
      year: dto.year,
      licensePlate: dto.licensePlate,
      plateState: dto.plateState,
      fuelType: dto.fuelType,
      sleeperBerth: dto.sleeperBerth,
      odometerMi: dto.odometerMi,
      busType: dto.busType,
      notes: dto.notes,
      ...(dto.groupId && { group: { connect: { id: dto.groupId } } }),
    };
  }

  /** A `groupId` naming no group is a 404, not a raw FK violation surfacing as a 500. */
  private async assertGroupExists(groupId: string | null | undefined): Promise<void> {
    if (!groupId) return;
    if (!(await this.vehicles.groupExists(groupId))) {
      throw new AppException(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.', 404);
    }
  }

  private toUpdateInput(dto: UpdateVehicleDto): Prisma.VehicleUpdateInput {
    return {
      ...(dto.unitNumber !== undefined && { unitNumber: dto.unitNumber }),
      ...(dto.vin !== undefined && { vin: dto.vin }),
      ...(dto.make !== undefined && { make: dto.make }),
      ...(dto.model !== undefined && { model: dto.model }),
      ...(dto.year !== undefined && { year: dto.year }),
      ...(dto.licensePlate !== undefined && { licensePlate: dto.licensePlate }),
      ...(dto.plateState !== undefined && { plateState: dto.plateState }),
      ...(dto.fuelType !== undefined && { fuelType: dto.fuelType }),
      ...(dto.sleeperBerth !== undefined && { sleeperBerth: dto.sleeperBerth }),
      ...(dto.busType !== undefined && { busType: dto.busType }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.groupId !== undefined && {
        group: dto.groupId === null ? { disconnect: true } : { connect: { id: dto.groupId } },
      }),
    };
  }

  private toExportRow(v: Vehicle): CreateVehicleDto {
    return {
      unitNumber: v.unitNumber,
      vin: v.vin,
      make: v.make ?? undefined,
      model: v.model ?? undefined,
      year: v.year ?? undefined,
      licensePlate: v.licensePlate ?? undefined,
      plateState: v.plateState ?? undefined,
      fuelType: v.fuelType,
      sleeperBerth: v.sleeperBerth,
      odometerMi: v.odometerMi,
      busType: v.busType ?? undefined,
      notes: v.notes ?? undefined,
      groupId: v.groupId ?? undefined,
    };
  }
}
