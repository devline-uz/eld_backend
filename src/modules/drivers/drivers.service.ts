import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import type { Driver, DriverDocument, Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppConfigService } from '../../core/config/config.service';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { AttachmentsService } from '../attachments/attachments.service';
import { hashPassword } from '../auth/lib/password.util';
import { TokenService } from '../auth/token.service';
import { MAIL_PORT, MailPort } from '../transfers/mail.port';
import {
  CreateDriverDocumentDto,
  DRIVER_DOCUMENT_CONTENT_TYPES,
  CreateDriverDto,
  DriverListQueryDto,
  ImportDriversDto,
  ImportDriversOptionsDto,
  UpdateDriverDto,
  VerifyDriverEmailDto,
} from './dto/drivers.dto';
import { DriversRepository } from './drivers.repository';
import {
  cdlKey,
  DRIVER_CONFLICT_MESSAGES,
  DriverConflictField,
  normalizeEmail,
  phoneKey,
  trimOrNull,
} from './lib/driver-uniques';

export type DriverView = Omit<Driver, 'passwordHash'>;

/** TZ §17 — a presigned upload is short-lived like every other presigned URL (15 min). */
const DRIVER_DOCUMENT_UPLOAD_TTL_SEC = 15 * 60;

const SORTABLE_FIELDS = ['username', 'firstName', 'lastName', 'cdlNumber', 'status', 'registeredAt'] as const;

const DEFAULT_IMPORT_OPTIONS: ImportDriversOptionsDto = {
  duplicateStrategy: 'UPDATE',
  sendInvitations: false,
  applyDefaultExemptions: false,
};

function toView(driver: Driver): DriverView {
  const { passwordHash: _hash, ...view } = driver;
  return view;
}

/** Prisma unique-constraint violation (`P2002`) — raised by the live-row partial unique indexes on
 * `username` / `email` / phone / licence number, or `Driver_assignedVehicleId_key` (a concurrent
 * create/update racing the pre-check). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/** Which column the `P2002` names — `meta.target` is the field list or the index name. */
function uniqueViolationTarget(err: unknown): string {
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  if (Array.isArray(target)) return target.join(',');
  return typeof target === 'string' ? target : '';
}

const TAKEN_CODES: Record<DriverConflictField, (typeof ERROR_CODES)[keyof typeof ERROR_CODES]> = {
  username: ERROR_CODES.USERNAME_TAKEN,
  email: ERROR_CODES.EMAIL_TAKEN,
  phone: ERROR_CODES.PHONE_TAKEN,
  cdlNumber: ERROR_CODES.CDL_NUMBER_TAKEN,
  assignedVehicleId: ERROR_CODES.VEHICLE_ALREADY_ASSIGNED,
};

/** B-100 — field-level 409: `{ code: <FIELD>_TAKEN | VEHICLE_ALREADY_ASSIGNED, message, details: { <field>: message } }`. */
function driverConflict(field: DriverConflictField): AppException {
  const message = DRIVER_CONFLICT_MESSAGES[field];
  return new AppException(TAKEN_CODES[field], message, 409, { [field]: message });
}

/** The unique values a driver write is checked on (already normalised). */
interface DriverUniques {
  username?: string;
  email?: string | null;
  phone?: string | null;
  cdlNumber?: string;
}

export interface ImportSummary {
  imported: number;
  updated: number;
  skipped?: number;
  failed: Array<{ index: number; error: string }>;
}

export interface DriverDocumentView {
  id: string;
  type: string;
  fileName: string;
  expiresAt: string | null;
  uploadedAt: string;
  url: string;
}

/**
 * TZ §5.3 — driver CDL/exception-flag CRUD backing the "Drivers" and "Driver profile" Figma
 * screens. Password handling mirrors `UsersService.invite`: a driver created without an
 * explicit `password` gets a random one, hashed and never returned (TZ §6.5).
 */
@Injectable()
export class DriversService {
  constructor(
    private readonly drivers: DriversRepository,
    private readonly tokens: TokenService,
    private readonly config: AppConfigService,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly attachments: AttachmentsService,
  ) {}

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
    // Soft-deleted drivers are gone as far as the web is concerned.
    if (!driver || driver.deletedAt) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    return driver;
  }

  /** A write that loses a race to the pre-check hits a unique index (`P2002`); surface it as the
   * same field-level 409 the pre-check would have thrown, never a raw 500. `meta.target` is the
   * column list, the index name, or (expression indexes) the index expression. */
  private async conflictOnDuplicate<T>(write: Promise<T>): Promise<T> {
    try {
      return await write;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const target = uniqueViolationTarget(err);
      if (/assignedVehicleId/i.test(target)) throw driverConflict('assignedVehicleId');
      if (/email/i.test(target)) throw driverConflict('email');
      if (/username/i.test(target)) throw driverConflict('username');
      if (/phone/i.test(target)) throw driverConflict('phone');
      if (/cdl/i.test(target)) throw driverConflict('cdlNumber');
      throw AppException.conflict('A driver with one of these values already exists.');
    }
  }

  /**
   * B-100 — every unique value a create/update/import row carries, checked against LIVE drivers
   * (the driver being edited excluded), in the web's field order. Undefined / empty values are
   * skipped (a driver with no email / phone never conflicts).
   */
  private async assertUniquesAvailable(values: DriverUniques, exceptDriverId?: string): Promise<void> {
    if (values.username !== undefined) {
      const existing = await this.drivers.findByUsername(values.username);
      if (existing && existing.id !== exceptDriverId) throw driverConflict('username');
    }
    if (values.email) {
      const existing = await this.drivers.findByEmail(values.email);
      if (existing && existing.id !== exceptDriverId) throw driverConflict('email');
    }
    const phone = phoneKey(values.phone);
    if (phone && (await this.drivers.findLiveIdByPhoneKey(phone, exceptDriverId))) throw driverConflict('phone');
    const cdl = cdlKey(values.cdlNumber);
    if (cdl && (await this.drivers.findLiveIdByCdlKey(cdl, exceptDriverId))) throw driverConflict('cdlNumber');
  }

  /** B-100 — a create may only take a FREE unit: one another live driver has is a 409
   * `VEHICLE_ALREADY_ASSIGNED` and stays with that driver; an OOS unit keeps the 11.5 hard rule. */
  private async assertVehicleAssignable(vehicleId: string | null | undefined): Promise<void> {
    if (!vehicleId) return;
    const vehicle = await this.drivers.findVehicleForAssignment(vehicleId);
    if (!vehicle || vehicle.deletedAt) {
      throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { assignedVehicleId: 'Select a unit.' });
    }
    if (vehicle.status === 'OUT_OF_SERVICE') {
      const message = 'Vehicle is out of service and cannot be assigned a driver.';
      throw new AppException(ERROR_CODES.VEHICLE_OUT_OF_SERVICE, message, 409, { assignedVehicleId: message });
    }
    if (vehicle.driver && !vehicle.driver.deletedAt) throw driverConflict('assignedVehicleId');
  }

  async create(dto: CreateDriverDto): Promise<DriverView & { inviteCode?: string }> {
    const data = this.normalizeCreate(dto);
    await this.assertUniquesAvailable(data);
    await this.assertVehicleAssignable(dto.assignedVehicleId);

    const passwordHash = await hashPassword(dto.password ?? randomBytes(16).toString('hex'));
    const input = this.toCreateInput(data, passwordHash);
    const created = await this.conflictOnDuplicate(
      dto.assignedVehicleId ? this.drivers.createWithVehicle(input, dto.assignedVehicleId) : this.drivers.create(input),
    );

    // §20 B-82 — `sendInvitation` (default true, matching the previous always-on behavior).
    let inviteCode: string | undefined;
    if (dto.sendInvitation && created.email) {
      inviteCode = await this.dispatchOneTimeCode(created, 'Your OneBook ELD driver app invitation code');
    }
    return { ...toView(created), inviteCode };
  }

  async update(id: string, dto: UpdateDriverDto): Promise<DriverView> {
    await this.getRaw(id);
    const data = this.normalizeUpdate(dto);
    await this.assertUniquesAvailable(data, id);
    const updated = await this.conflictOnDuplicate(this.drivers.update({ id }, this.toUpdateInput(data)));
    return toView(updated);
  }

  /** Soft-delete only — see bugs.md B-009 (hard `DELETE` breaks on the `EldEvent` FK's
   * `SET NULL` action under the append-only `REVOKE`) and decisions.md (also correct on its
   * own merits: a driver with historical ELD events must never be dropped from the table).
   * `deletedAt` hides the row from every web read and frees its username / email for a new driver
   * (partial unique indexes cover live rows only); driver-app login also ignores it. */
  async remove(id: string): Promise<DriverView> {
    await this.getRaw(id);
    const updated = await this.drivers.update(
      { id },
      { status: 'TERMINATED', deletedAt: new Date(), assignedVehicle: { disconnect: true } },
    );
    return toView(updated);
  }

  /** `GET /drivers/export` — plain JSON, shaped exactly like `CreateDriverDto[]` so it
   * round-trips straight back through `POST /drivers/import` without loss (minus password,
   * which is never exported — TZ §6.5). */
  async exportAll(): Promise<CreateDriverDto[]> {
    const drivers = await this.drivers.listAll();
    return drivers.map((d) => this.toExportRow(d));
  }

  /**
   * §20 B-69 — `options` actually change the result: `duplicateStrategy` picks SKIP / UPDATE /
   * CREATE per row, `defaultHomeTerminalName` backfills a missing `homeTerminalName`,
   * `applyDefaultExemptions` turns on the standard HOS exception set for newly-created rows,
   * `sendInvitations` fans out one invite per newly-created row. No `options` = prior behavior
   * (upsert by `username`, no invitations).
   */
  async importMany(dto: ImportDriversDto): Promise<ImportSummary> {
    const options = dto.options ?? DEFAULT_IMPORT_OPTIONS;
    const summary: ImportSummary = { imported: 0, updated: 0, skipped: 0, failed: [] };
    for (let index = 0; index < dto.drivers.length; index += 1) {
      const row = this.applyImportDefaults(dto.drivers[index], options);
      try {
        const existing = await this.drivers.findByUsername(row.username.trim());
        if (existing) {
          if (options.duplicateStrategy === 'SKIP') {
            summary.skipped = (summary.skipped ?? 0) + 1;
            continue;
          }
          if (options.duplicateStrategy === 'CREATE') {
            // Explicit CREATE on a known username collides on the unique constraint — surfaced
            // as a per-row error rather than silently upserting (TZ §20 "reject as a whole" is
            // for the transaction; a per-row duplicate is a real per-row error).
            summary.failed.push({ index, error: `Username "${row.username}" already exists.` });
            continue;
          }
          const { username: _username, password: _password, assignedVehicleId: _unit, ...updateRow } = row;
          const data = this.normalizeUpdate(updateRow);
          await this.assertUniquesAvailable(data, existing.id);
          await this.conflictOnDuplicate(this.drivers.update({ id: existing.id }, this.toUpdateInput(data)));
          summary.updated += 1;
        } else {
          const data = this.normalizeCreate(row);
          // The username was just looked up (no live driver has it) — check the rest.
          await this.assertUniquesAvailable({ ...data, username: undefined });
          await this.assertVehicleAssignable(row.assignedVehicleId);
          const passwordHash = await hashPassword(row.password ?? randomBytes(16).toString('hex'));
          const input = this.toCreateInput(data, passwordHash);
          const created = await this.conflictOnDuplicate(
            row.assignedVehicleId ? this.drivers.createWithVehicle(input, row.assignedVehicleId) : this.drivers.create(input),
          );
          summary.imported += 1;
          if (options.sendInvitations && created.email) {
            await this.dispatchOneTimeCode(created, 'Your OneBook ELD driver app invitation code');
          }
        }
      } catch (err) {
        summary.failed.push({ index, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    return summary;
  }

  private applyImportDefaults(row: CreateDriverDto, options: ImportDriversOptionsDto): CreateDriverDto {
    return {
      ...row,
      homeTerminalName: row.homeTerminalName || options.defaultHomeTerminalName || row.homeTerminalName,
      ...(options.applyDefaultExemptions && {
        allowPersonalConveyance: true,
        allowYardMove: true,
      }),
    };
  }

  // -------------------------------------------------------------------
  // §20 B-81 — carrier-side driver app password reset.
  // -------------------------------------------------------------------

  /** `POST /drivers/:id/reset-password` — always audited on the controller (TZ hard rule).
   * Immediately rotates the driver's app password to a fresh one-time code; the code is
   * emailed when the driver has an email on file, otherwise returned for the dispatcher to
   * read out loud (`tz.md` "yoki dispetcher aytib beradigan bir martalik kod"). */
  async resetPassword(id: string): Promise<{ emailedTo: string | null; code?: string }> {
    const driver = await this.getRaw(id);
    const code = this.generateOneTimeCode();
    await this.drivers.update({ id }, { passwordHash: await hashPassword(code) });
    // B-094 — a carrier reset is typically "lost/stolen phone": the old refresh tokens must
    // stop working too, not just the old password (same as AuthService.resetPassword for users).
    await this.drivers.revokeAllSessions(id);
    if (driver.email) {
      await this.mail.send({
        to: driver.email,
        subject: 'Your OneBook ELD driver app password was reset',
        text: `Your driver app password was reset by your carrier. New one-time password: ${code}`,
        attachments: [],
      });
      return { emailedTo: driver.email, ...(this.config.echoOneTimeSecrets ? { code } : {}) };
    }
    return { emailedTo: null, code };
  }

  // -------------------------------------------------------------------
  // §20 B-29/B-30/B-31 — driver email verification.
  // -------------------------------------------------------------------

  async sendVerification(id: string): Promise<{ emailedTo: string; code?: string }> {
    const driver = await this.getRaw(id);
    if (!driver.email) throw AppException.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Driver has no email on file to verify.');
    const token = this.tokens.signDriverEmailVerifyToken(driver.id, driver.email);
    await this.mail.send({
      to: driver.email,
      subject: 'Verify your OneBook ELD driver email',
      text: `Verification token: ${token}`,
      attachments: [],
    });
    return { emailedTo: driver.email, ...(this.config.echoOneTimeSecrets ? { code: token } : {}) };
  }

  async verifyEmail(id: string, dto: VerifyDriverEmailDto): Promise<DriverView> {
    const driver = await this.getRaw(id);
    const { driverId, email } = this.tokens.verifyDriverEmailVerifyToken(dto.token);
    if (driverId !== id || email !== driver.email) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Verification token is no longer valid.', 401);
    }
    const updated = await this.drivers.update({ id }, { emailVerifiedAt: new Date() });
    return toView(updated);
  }

  // -------------------------------------------------------------------
  // §20 B-94 (tz.md §20 B-16) — driver qualification documents.
  // -------------------------------------------------------------------

  async listDocuments(driverId: string): Promise<DriverDocumentView[]> {
    await this.getRaw(driverId);
    const rows = await this.drivers.listDocuments(driverId);
    return Promise.all(rows.map((d) => this.toDocumentView(d)));
  }

  /** Returns a presigned PUT for the caller to upload the actual bytes to, plus the row the
   * upload will fill in. Storage is the existing `StoragePort` (MinIO dev / S3 prod, TZ §17) —
   * no separate presign service exists yet in this module tree, see task note. */
  async createDocument(driverId: string, dto: CreateDriverDocumentDto): Promise<DriverDocumentView & { uploadUrl: string }> {
    await this.getRaw(driverId);
    // B-091 — the key is fully server-generated: the caller's `fileName` (which may hold `/`,
    // `..`, control chars) is display metadata only, and the extension follows the allowlisted
    // content type. The PUT signature binds content-type and exact content-length.
    const fileKey = `driver-documents/${driverId}/${randomBytes(16).toString('hex')}.${DRIVER_DOCUMENT_CONTENT_TYPES[dto.contentType]}`;
    const uploadUrl = await this.storage.presignPut(fileKey, dto.contentType, DRIVER_DOCUMENT_UPLOAD_TTL_SEC, dto.sizeBytes);
    const created = await this.drivers.createDocument({
      driver: { connect: { id: driverId } },
      type: dto.type,
      fileName: dto.fileName,
      fileKey,
      expiresAt: dto.expiresAt,
    });
    const view = await this.toDocumentView(created);
    return { ...view, uploadUrl };
  }

  async deleteDocument(driverId: string, docId: string): Promise<void> {
    await this.getRaw(driverId);
    const doc = await this.drivers.findDocument(docId);
    if (!doc || doc.driverId !== driverId) {
      throw new AppException(ERROR_CODES.DRIVER_DOCUMENT_NOT_FOUND, 'Driver document not found.', 404);
    }
    await this.storage.delete(doc.fileKey).catch(() => undefined);
    await this.drivers.deleteDocument(docId);
  }

  private async toDocumentView(d: DriverDocument): Promise<DriverDocumentView> {
    return {
      id: d.id,
      type: d.type,
      fileName: d.fileName,
      expiresAt: d.expiresAt ? d.expiresAt.toISOString() : null,
      uploadedAt: d.createdAt.toISOString(),
      // Reuses the shared, no-authorization-check presign wrapper (`AttachmentsService
      // .presignKey`) rather than `STORAGE_PORT.presignGet` directly — caller access to this
      // driver's documents is already decided by `Perm('drivers', 'READ')` above it.
      url: (await this.attachments.presignKey(d.fileKey)).url,
    };
  }

  // -------------------------------------------------------------------

  private generateOneTimeCode(): string {
    // randomInt's upper bound is exclusive — 1_000_000 keeps 999999 reachable.
    return String(randomInt(100000, 1_000_000));
  }

  /** Shared by `create({ sendInvitation: true })` and the drivers-import `sendInvitations`
   * option — Phase 1 has no SMTP client wired for real, `MAIL_PORT`'s default provider logs
   * and returns undelivered (see `mail.port.ts`); the code is still returned outside
   * production so the flow is testable end-to-end, matching `AuthService.forgotPassword`. */
  private async dispatchOneTimeCode(driver: Driver, subject: string): Promise<string | undefined> {
    if (!driver.email) return undefined;
    const code = this.generateOneTimeCode();
    await this.drivers.update({ id: driver.id }, { passwordHash: await hashPassword(code) });
    await this.mail.send({ to: driver.email, subject, text: `One-time code: ${code}`, attachments: [] });
    return this.config.echoOneTimeSecrets ? code : undefined;
  }

  /** B-100 — the shared normalisation for create / import rows: username / phone / licence number
   * trimmed, email trimmed + lower-cased (`''` -> no value). */
  private normalizeCreate(dto: CreateDriverDto): CreateDriverDto {
    return {
      ...dto,
      username: dto.username.trim(),
      email: normalizeEmail(dto.email) ?? undefined,
      phone: trimOrNull(dto.phone) ?? undefined,
      cdlNumber: dto.cdlNumber.trim(),
    };
  }

  /** Same as `normalizeCreate` for a partial update; `undefined` (not sent) stays `undefined`. */
  private normalizeUpdate(dto: UpdateDriverDto): UpdateDriverDto {
    return {
      ...dto,
      ...(dto.email !== undefined && { email: normalizeEmail(dto.email) ?? undefined }),
      // `''` stays `''` so a PATCH can still clear the phone (an empty phone never conflicts).
      ...(dto.phone !== undefined && { phone: dto.phone.trim() }),
      ...(dto.cdlNumber !== undefined && { cdlNumber: dto.cdlNumber.trim() }),
    };
  }

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
      sendInvitation: true,
    };
  }
}
