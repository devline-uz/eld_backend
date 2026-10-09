import { Injectable, Logger } from '@nestjs/common';
import { EditorType, MaintenanceScheduleStatus, type MaintenanceSchedule, type Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { RequestContext } from '../../core/context/request-context';
import { AuditRepository } from '../audit/audit.repository';
import { computeDue } from '../service/maintenance-due';
import type { MaintenanceSubmitDto } from './dto/mobile-maintenance.dto';
import { MaintenanceWithInvoice, MobileMaintenanceRepository } from './mobile-maintenance.repository';
import { MobileRepository } from './mobile.repository';

export type MobileMaintenanceStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED' | 'REJECTED';

export interface MobileMaintenanceListItem {
  id: string;
  scheduleType: string;
  scheduleName: string;
  frequencyMi: number | null;
  /** Miles until due on the selected unit's odometer; NEGATIVE = overdue by that many miles; null = no mileage interval. */
  remainingMi: number | null;
  status: MobileMaintenanceStatus;
  at: string | null;
}

export interface MobileMaintenanceDetail extends MobileMaintenanceListItem {
  invoiceNumber: string | null;
  vendorName: string | null;
  cost: number | null;
  notes: string | null;
  invoiceAttachment: { id: string; fileName: string; mimeType: string } | null;
  submittedAt: string | null;
  reviewNote: string | null;
}

const MIME_EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
const LEDGER_TYPE = 'maintenance_submit';

/**
 * M-38..M-42 — the driver's maintenance tasks for the unit they currently have selected. A row of
 * another unit is a 404 (never confirmed to exist). The platform is single-carrier (`Carrier.id =
 * 'carrier'`), so "the unit and its company" is the unit alone — there is no tenant column.
 */
@Injectable()
export class MobileMaintenanceService {
  private readonly logger = new Logger(MobileMaintenanceService.name);

  constructor(
    private readonly repo: MobileMaintenanceRepository,
    private readonly mobileRepo: MobileRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(driverId: string): Promise<MobileMaintenanceListItem[]> {
    const unit = await this.repo.findDriverUnit(driverId);
    if (!unit) return [];
    const now = new Date();
    const items = (await this.repo.listForVehicle(unit.vehicleId)).map((row) => toListItem(row, unit.odometerMi, now));
    // Actionable (OPEN / REJECTED) first, most overdue first; finished/cancelled rows last.
    const rank = (status: MobileMaintenanceStatus) => (status === 'OPEN' || status === 'REJECTED' ? 0 : 1);
    return items.sort(
      (a, b) => rank(a.status) - rank(b.status) || (a.remainingMi ?? Number.MAX_SAFE_INTEGER) - (b.remainingMi ?? Number.MAX_SAFE_INTEGER) || a.scheduleName.localeCompare(b.scheduleName),
    );
  }

  async get(driverId: string, id: string): Promise<MobileMaintenanceDetail> {
    const unit = await this.repo.findDriverUnit(driverId);
    const row = unit ? await this.repo.findOneForVehicle(id, unit.vehicleId) : null;
    if (!unit || !row) throw notFound(id);
    return toDetail(row, unit.odometerMi, new Date());
  }

  /**
   * Submits the service invoice for review. Allowed while the task is OPEN or was REJECTED (resubmit),
   * or when a COMPLETED recurring task has come due again. Idempotent on `clientId` through the shared
   * `SyncedChange` ledger (replay -> first answer; a `clientId` spent on another operation -> 409).
   */
  async submit(driverId: string, id: string, dto: MaintenanceSubmitDto): Promise<MobileMaintenanceDetail> {
    const prior = await this.mobileRepo.findSyncedByClientId(driverId, dto.clientId);
    if (prior && prior.type !== LEDGER_TYPE) {
      throw AppException.conflict('clientId already used by another operation.', { clientId: dto.clientId });
    }
    if (prior?.status === 'ACCEPTED' && prior.result) {
      const replay = prior.result as unknown as MobileMaintenanceDetail;
      // B-150 — a clientId replays only the task it was spent on; reused for another task it is a 409,
      // not that other task's cached answer.
      if (replay.id !== id) throw AppException.conflict('clientId already used for another maintenance task.', { clientId: dto.clientId });
      return replay;
    }

    const unit = await this.repo.findDriverUnit(driverId);
    const row = unit ? await this.repo.findOneForVehicle(id, unit.vehicleId) : null;
    if (!unit || !row) throw notFound(id);

    const now = new Date();
    const effective = effectiveStatus(row, unit.odometerMi, now);
    if (effective !== 'OPEN' && effective !== 'REJECTED') {
      throw AppException.conflict(`A ${effective} maintenance task cannot be submitted.`, { id, status: effective });
    }

    if (dto.invoiceAttachmentId) {
      const attachment = await this.repo.findOwnInvoiceAttachment(dto.invoiceAttachmentId, driverId, id);
      if (!attachment) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'invoiceAttachmentId must be an INVOICE upload of this driver (POST /mobile/signature, purpose INVOICE).', 422, {
          invoiceAttachmentId: 'Unknown, not yours, or already the invoice of another task.',
        });
      }
    }

    const saved = await this.repo.saveSubmission(id, {
      status: MaintenanceScheduleStatus.OPEN,
      invoiceNumber: dto.invoiceNumber,
      vendorName: dto.vendorName,
      cost: dto.cost,
      invoiceNotes: dto.notes?.trim() || null,
      invoiceAttachmentId: dto.invoiceAttachmentId ?? null,
      submittedById: driverId,
      submittedAt: now,
      // A fresh submission restarts the review: the previous verdict no longer applies.
      reviewNote: null,
      reviewedAt: null,
      reviewedById: null,
    });
    const result = toDetail(saved, unit.odometerMi, now);

    await this.mobileRepo.recordSyncedResult(driverId, dto.clientId, LEDGER_TYPE, now, 'ACCEPTED', null, JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue);
    try {
      await this.audit.insert({
        actorId: driverId,
        actorType: EditorType.DRIVER,
        action: 'MAINTENANCE_SUBMITTED',
        objectType: 'MaintenanceSchedule',
        objectId: id,
        before: { status: row.status, invoiceNumber: row.invoiceNumber },
        after: { status: 'OPEN', invoiceNumber: dto.invoiceNumber, vendorName: dto.vendorName, cost: dto.cost, invoiceAttachmentId: dto.invoiceAttachmentId ?? null },
        detail: 'Driver submitted a maintenance invoice from the app (M-40).',
        ip: RequestContext.get()?.ip,
        userAgent: RequestContext.get()?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, id }, 'Failed to write the maintenance-submit audit entry');
    }
    return result;
  }
}

function notFound(id: string): AppException {
  return new AppException(ERROR_CODES.MAINTENANCE_SCHEDULE_NOT_FOUND, 'Maintenance task not found.', 404, { id });
}

function dueOf(row: MaintenanceSchedule, odometerMi: number, now: Date) {
  return computeDue({
    intervalMi: row.intervalMi,
    intervalDays: row.intervalDays,
    lastServiceMi: row.lastServiceMi,
    lastServiceAt: row.lastServiceAt,
    currentOdometerMi: odometerMi,
    now,
  });
}

/**
 * A COMPLETED recurring task whose interval has come round again is OPEN for the driver: the
 * back-office approval reset the clock (`lastService*`), and the next cycle is a new task.
 */
export function effectiveStatus(row: MaintenanceSchedule, odometerMi: number, now: Date): MobileMaintenanceStatus {
  if (row.status === 'COMPLETED' && dueOf(row, odometerMi, now).state !== 'OK') return 'OPEN';
  return row.status;
}

function toListItem(row: MaintenanceSchedule, odometerMi: number, now: Date): MobileMaintenanceListItem {
  const due = dueOf(row, odometerMi, now);
  const status = effectiveStatus(row, odometerMi, now);
  // `at`: when it was done (COMPLETED), else when the driver last submitted, else when it falls due.
  const at =
    status === 'COMPLETED' ? (row.lastServiceAt ?? row.reviewedAt)
    : row.status === 'COMPLETED' ? due.nextDueAt // came due again: a new cycle, last cycle's submission is not shown
    : (row.submittedAt ?? due.nextDueAt);
  return {
    id: row.id,
    scheduleType: row.scheduleType,
    scheduleName: row.name,
    frequencyMi: row.intervalMi,
    remainingMi: due.milesRemaining,
    status,
    at: at ? at.toISOString() : null,
  };
}

function toDetail(row: MaintenanceWithInvoice, odometerMi: number, now: Date): MobileMaintenanceDetail {
  const item = toListItem(row, odometerMi, now);
  // A COMPLETED task that came due again starts a new cycle: last cycle's submission is not shown.
  const newCycle = row.status === 'COMPLETED' && item.status === 'OPEN';
  const attachment = newCycle ? null : row.invoiceAttachment;
  return {
    ...item,
    invoiceNumber: newCycle ? null : row.invoiceNumber,
    vendorName: newCycle ? null : row.vendorName,
    cost: newCycle || row.cost === null ? null : Number(row.cost),
    notes: newCycle ? null : row.invoiceNotes,
    invoiceAttachment: attachment
      ? { id: attachment.id, fileName: invoiceFileName(row.invoiceNumber, attachment), mimeType: attachment.mimeType }
      : null,
    submittedAt: newCycle || !row.submittedAt ? null : row.submittedAt.toISOString(),
    reviewNote: newCycle ? null : row.reviewNote,
  };
}

/** The attachment keeps no original file name; derive a readable, filesystem-safe one. */
function invoiceFileName(invoiceNumber: string | null, attachment: { id: string; mimeType: string }): string {
  const ext = MIME_EXT[attachment.mimeType] ?? 'bin';
  const base = invoiceNumber?.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return `invoice-${base || attachment.id.slice(0, 8)}.${ext}`;
}
