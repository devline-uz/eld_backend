import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { EditorType, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { AuditRepository } from '../audit/audit.repository';
import type { DvirSubmitDto, SignatureUploadDto } from './dto/mobile.dto';
import { DvirPhotosRepository } from './dvir-photos.repository';
import { MobileCatalogRepository } from './mobile-catalog.repository';
import { MobileRepository } from './mobile.repository';
import { SignatureService } from './signature.service';

/**
 * TZ §5.10 / §6 / §11.8 — `POST /mobile/dvir` and `POST /mobile/signature`.
 *
 * The full DVIR workflow (work orders, defect resolution, mechanic sign-off) is Phase 7's
 * scope. This is only the driver-side SUBMISSION: capture the inspection, the defects and the
 * signature, and — per the schema's own out-of-service rule — flip the vehicle out of service
 * immediately when a CRITICAL defect is open, because that decision cannot wait for a fleet
 * manager to look at a screen.
 */
@Injectable()
export class MobileDvirService {
  private readonly logger = new Logger(MobileDvirService.name);

  constructor(
    private readonly repo: MobileRepository,
    private readonly photos: DvirPhotosRepository,
    private readonly signatures: SignatureService,
    private readonly audit: AuditRepository,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
    private readonly catalog: MobileCatalogRepository,
  ) {}

  async uploadSignature(driverId: string, dto: SignatureUploadDto) {
    const prefix = dto.purpose === 'DVIR_PHOTO' ? 'dvir-photos' : dto.purpose === 'INVOICE' ? 'invoices' : 'signatures';
    const stored = await this.signatures.store(prefix, driverId, dto.base64, dto.mimeType);
    if (dto.purpose === 'INVOICE') {
      // M-39 — the invoice file is an `Attachment` (kind INVOICE) owned by the uploader; the id is
      // what `POST /mobile/maintenance/:id/submit` takes as `invoiceAttachmentId`, and the existing
      // `GET /attachments/:id/presign` lets the uploading driver read it back.
      await this.photos.createPhoto({ id: stored.id, key: stored.key, mimeType: dto.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, driverId, kind: 'INVOICE' });
      return { signatureImageId: stored.id, attachmentId: stored.id, key: stored.key, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
    }
    if (dto.purpose === 'DVIR_PHOTO') {
      // MB-6 — a DVIR photo must exist as an `Attachment` row so `POST /mobile/dvir`
      // (`defects[].photoAttachmentIds`) can link it to the defect. Signatures stay key-only
      // (`Dvir.driverSignatureUrl` / `DailyLog.signatureUrl`).
      await this.photos.createPhoto({ id: stored.id, key: stored.key, mimeType: dto.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, driverId });
    }
    return { signatureImageId: stored.id, attachmentId: dto.purpose === 'DVIR_PHOTO' ? stored.id : null, key: stored.key, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
  }

  /**
   * `POST /mobile/dvir` entry point. Idempotent on `dto.clientId` through the shared `SyncedChange`
   * ledger (a replayed offline request returns the first answer); a `clientId` already spent on
   * another operation type is a 409 (B-122). The `POST /mobile/sync` path calls `submit` directly —
   * it has its own per-change ledger.
   */
  async submitIdempotent(driverId: string, dto: DvirSubmitDto, actor: ContextUser) {
    if (!dto.clientId) return this.submit(driverId, dto, actor);
    const prior = await this.repo.findSyncedByClientId(driverId, dto.clientId);
    if (prior && prior.type !== 'dvir_submit') {
      throw AppException.conflict('clientId already used by another operation.', { clientId: dto.clientId });
    }
    if (prior?.status === 'ACCEPTED' && prior.result) return prior.result as unknown as Awaited<ReturnType<MobileDvirService['submit']>>;

    const result = await this.submit(driverId, dto, actor);
    await this.repo.recordSyncedResult(driverId, dto.clientId, 'dvir_submit', new Date(), 'ACCEPTED', null, JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue);
    return result;
  }

  async submit(driverId: string, dto: DvirSubmitDto, actor: ContextUser) {
    const vehicle = await this.repo.findVehicle(dto.vehicleId);
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId: dto.vehicleId });

    // A soft-deleted trailer cannot be inspected anymore — unless the inspection itself happened
    // before the delete (an offline DVIR synced late), which is a true historical record.
    if (dto.trailerId) {
      const trailer = await this.repo.findTrailer(dto.trailerId);
      if (!trailer) {
        throw new AppException(ERROR_CODES.TRAILER_NOT_FOUND, 'Trailer not found.', 422, { trailerId: 'Trailer not found.' });
      }
      if (trailer.deletedAt && trailer.deletedAt <= new Date(dto.submittedAt)) {
        throw new AppException(ERROR_CODES.TRAILER_NOT_FOUND, 'This trailer has been deleted and cannot be inspected.', 422, {
          trailerId: 'This trailer has been deleted and cannot be inspected.',
        });
      }
    }

    // MB-6 — every referenced photo must be the driver's own, not yet attached DVIR_PHOTO upload;
    // checked BEFORE the signature is stored so a bad id leaves no orphan object behind.
    const photoIds = [...new Set(dto.defects.flatMap((defect) => defect.photoAttachmentIds))];
    if (photoIds.length) {
      const linkable = new Set((await this.photos.findLinkable(photoIds, driverId)).map((row) => row.id));
      const missing = photoIds.filter((id) => !linkable.has(id));
      if (missing.length) {
        throw new AppException(
          ERROR_CODES.VALIDATION_FAILED,
          'photoAttachmentIds must reference DVIR_PHOTO uploads of this driver that are not yet attached to a defect.',
          422,
          { missing },
        );
      }
    }

    // MR-10 — a mechanic signature needs the mechanic's name (it is the §396.13 sign-off record).
    const mechanicName = dto.mechanicName?.trim() || null;
    if (dto.mechanicSignatureBase64 && !mechanicName) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'mechanicName is required with mechanicSignatureBase64.', 422, {
        mechanicName: 'Required when a mechanic signature is sent.',
      });
    }

    await this.warnUnknownCategories(dto);

    const signature = await this.signatures.store('signatures', driverId, dto.signatureBase64, dto.signatureMimeType);
    const mechanicSignature = dto.mechanicSignatureBase64
      ? await this.signatures.store('signatures', driverId, dto.mechanicSignatureBase64, dto.mechanicSignatureMimeType ?? 'image/png')
      : null;

    const defects = dto.defects.map((defect) => ({
      vehicleId: dto.vehicleId,
      part: defect.part,
      category: defect.category,
      severity: defect.severity,
      description: defect.description,
      outOfService: defect.severity === 'CRITICAL',
      photoAttachmentIds: defect.photoAttachmentIds,
    }));

    const dvir = await this.repo.createDvir({
      driverId,
      vehicleId: dto.vehicleId,
      trailerId: dto.trailerId ?? null,
      type: dto.type,
      submittedAt: dto.submittedAt,
      // MR-11 — optional: fall back to the unit's known odometer; NULL when neither is known.
      odometerMi: dto.odometerMi ?? knownOdometerMi(vehicle),
      latitude: dto.location?.lat ?? null,
      longitude: dto.location?.lon ?? null,
      locationName: dto.location?.name ?? null,
      vehicleCondition: dto.vehicleCondition,
      notes: dto.notes ?? null,
      driverSignatureUrl: signature.key,
      driverSignatureHash: signature.sha256,
      mechanicName,
      mechanicSignedAt: mechanicSignature ? new Date() : null,
      mechanicSignatureUrl: mechanicSignature?.key ?? null,
      mechanicSignatureHash: mechanicSignature?.sha256 ?? null,
      defects,
    });

    const hasOutOfService = defects.some((defect) => defect.outOfService);
    if (hasOutOfService) {
      await this.repo.markVehicleOutOfService(dto.vehicleId);
    }

    await this.writeAudit(actor, 'DVIR_SUBMITTED', dvir.id, {
      after: { driverId, vehicleId: dto.vehicleId, type: dto.type, vehicleCondition: dto.vehicleCondition, defectCount: defects.length, photoCount: photoIds.length, outOfService: hasOutOfService },
      detail: 'Driver DVIR submission from the app (§5.10).',
    });

    await this.events.publish('dvir.submitted', { dvirId: dvir.id, driverId, vehicleId: dto.vehicleId, outOfService: hasOutOfService });
    if (hasOutOfService) {
      await this.raiseAlert('alert.vehicle_out_of_service', { dvirId: dvir.id, vehicleId: dto.vehicleId, driverId });
    }

    return {
      id: dvir.id,
      driverId,
      vehicleId: dto.vehicleId,
      type: dto.type,
      submittedAt: dto.submittedAt,
      vehicleCondition: dto.vehicleCondition,
      defectCount: defects.length,
      photoCount: photoIds.length,
      outOfService: hasOutOfService,
      signatureImageId: signature.id,
      mechanicSignatureImageId: mechanicSignature?.id ?? null,
      applied: true,
    };
  }

  /**
   * MR-9 — `defects[].category` should be a `DefectCatalogItem.code` (or, for older app builds, its
   * English `name`). Validation is LENIENT on purpose (decisions.md D-122): an unknown value is
   * stored as sent and only logged, so a catalog edit can never reject a safety-critical DVIR.
   * One catalog query per submit, none per defect.
   */
  private async warnUnknownCategories(dto: DvirSubmitDto): Promise<void> {
    if (!dto.defects.length) return;
    try {
      const parts = [...new Set(dto.defects.map((defect) => defect.part))];
      const rows = await this.catalog.listCatalogLabels(parts);
      const known = new Set(rows.flatMap((row) => [`${row.part}:${row.code}`, `${row.part}:${row.name}`]));
      const unknown = dto.defects.filter((defect) => !known.has(`${defect.part}:${defect.category}`)).map((defect) => `${defect.part}:${defect.category}`);
      if (unknown.length) this.logger.warn({ unknownCategories: unknown }, 'DVIR submitted with defect categories outside the catalog (accepted)');
    } catch (err) {
      this.logger.error({ err }, 'Defect catalog lookup failed; DVIR accepted without category validation');
    }
  }

  private async raiseAlert(name: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.publish(name, payload);
    try {
      await this.alertQueue.add(name, payload);
    } catch (err) {
      this.logger.error({ err, alert: name }, 'Failed to enqueue alert');
    }
  }

  private async writeAudit(
    actor: ContextUser,
    action: string,
    objectId: string,
    data: { after: Record<string, unknown>; detail: string },
  ): Promise<void> {
    const ctx = RequestContext.get();
    try {
      await this.audit.insert({
        actorId: actor.id,
        actorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
        action,
        objectType: 'Dvir',
        objectId,
        after: data.after as Prisma.InputJsonValue,
        detail: data.detail,
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, action, objectId }, 'Failed to write the DVIR audit entry');
    }
  }
}

/** MR-11 — the unit's last known odometer, or null when it was never set/calibrated (`Vehicle.odometerMi` defaults to 0). */
function knownOdometerMi(vehicle: { odometerMi: number; deviceOdometerMi: number | null; odometerCalibratedAt: Date | null }): number | null {
  return vehicle.odometerMi > 0 || vehicle.deviceOdometerMi !== null || vehicle.odometerCalibratedAt !== null ? vehicle.odometerMi : null;
}
