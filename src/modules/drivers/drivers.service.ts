import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Driver, Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { hashPassword } from '../auth/lib/password.util';
import { CreateDriverDto, DriverListQueryDto, ImportDriversDto, UpdateDriverDto } from './dto/drivers.dto';
import { DriversRepository } from './drivers.repository';

export type DriverView = Omit<Driver, 'passwordHash'>;

const SORTABLE_FIELDS = ['username', 'firstName', 'lastName', 'cdlNumber', 'status', 'registeredAt'] as const;

function toView(driver: Driver): DriverView {
  const { passwordHash: _hash, ...view } = driver;
  return view;
}

export interface ImportSummary {
  imported: number;
  updated: number;
  failed: Array<{ index: number; error: string }>;
}

/**
 * TZ §5.3 — driver CDL/exception-flag CRUD backing the "Drivers" and "Driver profile" Figma
 * screens. Password handling mirrors `UsersService.invite`: a driver created without an
 * explicit `password` gets a random one, hashed and never returned (TZ §6.5).
 */
@Injectable()
export class DriversService {
  constructor(private readonly drivers: DriversRepository) {}

  async list(query: DriverListQueryDto): Promise<OffsetPage<DriverView>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { registeredAt: 'desc' });
    const { items, total } = await this.drivers.list({ status: query.status, q: query.q }, query.page, query.limit, orderBy);
    return toOffsetPage(items.map(toView), total, query.page, query.limit);
  }

  async get(id: string): Promise<DriverView> {
    return toView(await this.getRaw(id));
  }

  private async getRaw(id: string): Promise<Driver> {
    const driver = await this.drivers.findById({ id });
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    return driver;
  }

  async create(dto: CreateDriverDto): Promise<DriverView> {
    const existing = await this.drivers.findByUsername(dto.username);
    if (existing) throw AppException.conflict(`A driver with username "${dto.username}" already exists.`);

    const passwordHash = await hashPassword(dto.password ?? randomBytes(16).toString('hex'));
    const created = await this.drivers.create(this.toCreateInput(dto, passwordHash));
    return toView(created);
  }

  async update(id: string, dto: UpdateDriverDto): Promise<DriverView> {
    await this.getRaw(id);
    const updated = await this.drivers.update({ id }, this.toUpdateInput(dto));
    return toView(updated);
  }

  /** Soft-delete only — see bugs.md B-009 (hard `DELETE` breaks on the `EldEvent` FK's
   * `SET NULL` action under the append-only `REVOKE`) and decisions.md (also correct on its
   * own merits: a driver with historical ELD events must never be dropped from the table). */
  async remove(id: string): Promise<DriverView> {
    await this.getRaw(id);
    const updated = await this.drivers.update({ id }, { status: 'TERMINATED', assignedVehicle: { disconnect: true } });
    return toView(updated);
  }

  /** `GET /drivers/export` — plain JSON, shaped exactly like `CreateDriverDto[]` so it
   * round-trips straight back through `POST /drivers/import` without loss (minus password,
   * which is never exported — TZ §6.5). */
  async exportAll(): Promise<CreateDriverDto[]> {
    const drivers = await this.drivers.listAll();
    return drivers.map((d) => this.toExportRow(d));
  }

  /** Upserts by `username` (the driver's natural key) so re-importing an export is idempotent. */
  async importMany(dto: ImportDriversDto): Promise<ImportSummary> {
    const summary: ImportSummary = { imported: 0, updated: 0, failed: [] };
    for (let index = 0; index < dto.drivers.length; index += 1) {
      const row = dto.drivers[index];
      try {
        const existing = await this.drivers.findByUsername(row.username);
        if (existing) {
          await this.drivers.update({ id: existing.id }, this.toUpdateInput(row));
          summary.updated += 1;
        } else {
          const passwordHash = await hashPassword(row.password ?? randomBytes(16).toString('hex'));
          await this.drivers.create(this.toCreateInput(row, passwordHash));
          summary.imported += 1;
        }
      } catch (err) {
        summary.failed.push({ index, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    return summary;
  }

  /**
   * TZ hard rule — CRITICAL open defects put `Vehicle.status = OUT_OF_SERVICE` and block
   * driver assignment. The Defect/DVIR module lands in Phase 7; `VehiclesService.assignDriver`
   * already refuses assignment to a vehicle whose *current* `status` is `OUT_OF_SERVICE`, which
   * covers this rule end-to-end once Phase 7 starts flipping that status automatically.
   */
  private toCreateInput(dto: CreateDriverDto, passwordHash: string): Prisma.DriverCreateInput {
    return {
      username: dto.username,
      passwordHash,
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      phone: dto.phone,
      cdlNumber: dto.cdlNumber,
      cdlState: dto.cdlState,
      homeTerminalName: dto.homeTerminalName,
      homeTerminalTimezone: dto.homeTerminalTimezone,
      hosRuleset: dto.hosRuleset,
      allowPersonalConveyance: dto.allowPersonalConveyance,
      allowYardMove: dto.allowYardMove,
      adverseDrivingEnabled: dto.adverseDrivingEnabled,
      shortHaulException: dto.shortHaulException,
      splitSleeperEnabled: dto.splitSleeperEnabled,
      eldExempt: dto.eldExempt,
      eldExemptReason: dto.eldExemptReason,
      ...(dto.fleetManagerId && { fleetManager: { connect: { id: dto.fleetManagerId } } }),
    };
  }

  private toUpdateInput(dto: UpdateDriverDto): Prisma.DriverUpdateInput {
    return {
      ...(dto.firstName !== undefined && { firstName: dto.firstName }),
      ...(dto.lastName !== undefined && { lastName: dto.lastName }),
      ...(dto.email !== undefined && { email: dto.email }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.cdlNumber !== undefined && { cdlNumber: dto.cdlNumber }),
      ...(dto.cdlState !== undefined && { cdlState: dto.cdlState }),
      ...(dto.homeTerminalName !== undefined && { homeTerminalName: dto.homeTerminalName }),
      ...(dto.homeTerminalTimezone !== undefined && { homeTerminalTimezone: dto.homeTerminalTimezone }),
      ...(dto.hosRuleset !== undefined && { hosRuleset: dto.hosRuleset }),
      ...(dto.status !== undefined && { status: dto.status }),
      ...(dto.allowPersonalConveyance !== undefined && { allowPersonalConveyance: dto.allowPersonalConveyance }),
      ...(dto.allowYardMove !== undefined && { allowYardMove: dto.allowYardMove }),
      ...(dto.adverseDrivingEnabled !== undefined && { adverseDrivingEnabled: dto.adverseDrivingEnabled }),
      ...(dto.shortHaulException !== undefined && { shortHaulException: dto.shortHaulException }),
      ...(dto.splitSleeperEnabled !== undefined && { splitSleeperEnabled: dto.splitSleeperEnabled }),
      ...(dto.eldExempt !== undefined && { eldExempt: dto.eldExempt }),
      ...(dto.eldExemptReason !== undefined && { eldExemptReason: dto.eldExemptReason }),
      ...(dto.fleetManagerId !== undefined && {
        fleetManager: dto.fleetManagerId ? { connect: { id: dto.fleetManagerId } } : { disconnect: true },
      }),
    };
  }

  private toExportRow(d: Driver): CreateDriverDto {
    return {
      username: d.username,
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email ?? undefined,
      phone: d.phone ?? undefined,
      cdlNumber: d.cdlNumber,
      cdlState: d.cdlState,
      homeTerminalName: d.homeTerminalName,
      homeTerminalTimezone: d.homeTerminalTimezone,
      hosRuleset: d.hosRuleset,
      fleetManagerId: d.fleetManagerId ?? undefined,
      allowPersonalConveyance: d.allowPersonalConveyance,
      allowYardMove: d.allowYardMove,
      adverseDrivingEnabled: d.adverseDrivingEnabled,
      shortHaulException: d.shortHaulException,
      splitSleeperEnabled: d.splitSleeperEnabled,
      eldExempt: d.eldExempt,
      eldExemptReason: d.eldExemptReason ?? undefined,
    };
  }
}
