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
  ) {}

  async uploadSignature(driverId: string, dto: SignatureUploadDto) {
    const prefix = dto.purpose === 'DVIR_PHOTO' ? 'dvir-photos' : 'signatures';
    const stored = await this.signatures.store(prefix, driverId, dto.base64, dto.mimeType);
    if (dto.purpose === 'DVIR_PHOTO') {
      // MB-6 — a DVIR photo must exist as an `Attachment` row so `POST /mobile/dvir`
      // (`defects[].photoAttachmentIds`) can link it to the defect. Signatures stay key-only
      // (`Dvir.driverSignatureUrl` / `DailyLog.signatureUrl`).
      await this.photos.createPhoto({ id: stored.id, key: stored.key, mimeType: dto.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, driverId });
    }
    return { signatureImageId: stored.id, attachmentId: dto.purpose === 'DVIR_PHOTO' ? stored.id : null, key: stored.key, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
  }

  async submit(driverId: string, dto: DvirSubmitDto, actor: ContextUser) {
    const vehicle = await this.repo.findVehicle(dto.vehicleId);
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, { vehicleId: dto.vehicleId });

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

    const signature = await this.signatures.store('signatures', driverId, dto.signatureBase64, dto.signatureMimeType);

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
      odometerMi: dto.odometerMi,
      latitude: dto.location?.lat ?? null,
      longitude: dto.location?.lon ?? null,
      locationName: dto.location?.name ?? null,
      vehicleCondition: dto.vehicleCondition,
      notes: dto.notes ?? null,
      driverSignatureUrl: signature.key,
      driverSignatureHash: signature.sha256,
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
      applied: true,
    };
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
