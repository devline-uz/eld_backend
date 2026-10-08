import { Inject, Injectable } from '@nestjs/common';
import type { Attachment, Dvir } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { locationTextOf } from '../../common/geo-location/location-description';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { DvirWithDetail, MobileFleetOpsRepository } from './mobile-fleet-ops.repository';

const PRESIGN_TTL_SEC = 15 * 60;

/**
 * mobile/tz.md §21.1 MB-10, screens M-10/M-11/P-07 — the driver's own DVIR history.
 *
 * Read-only: `MobileDvirService` (§5.10) owns submission. `GET /mobile/dvirs/:id/pdf` has no
 * per-DVIR PDF generator to reuse yet — `ReportsModule`'s `DvirReportGenerator` only builds
 * the fleet-wide CSV job (`GET /reports/dvir`), never a single-record PDF with the signature
 * image embedded — so that route answers `501 NOT_IMPLEMENTED` until Phase 7/15 grows one.
 */
@Injectable()
export class MobileDvirHistoryService {
  constructor(
    private readonly repo: MobileFleetOpsRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  async list(driverId: string, days: number) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.repo.listOwnDvirs(driverId, since);
    return rows.map(toSummaryShape);
  }

  async get(id: string, driverId: string) {
    const dvir = await this.repo.getOwnDvir(id, driverId);
    if (!dvir) throw new AppException(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.', 404, { id });
    return this.toDetailShape(dvir);
  }

  async pdf(id: string, driverId: string): Promise<never> {
    // Ownership is still checked before reporting "not implemented" — never leak that a DVIR
    // id belonging to another driver exists.
    const dvir = await this.repo.getOwnDvir(id, driverId);
    if (!dvir) throw new AppException(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.', 404, { id });
    throw AppException.notImplemented('A single-DVIR PDF export');
  }

  private async toDetailShape(dvir: DvirWithDetail) {
    const driverSignatureUrl = dvir.driverSignatureUrl ? await this.storage.presignGet(dvir.driverSignatureUrl, PRESIGN_TTL_SEC) : null;
    const defects = await Promise.all(
      dvir.defects.map(async (defect) => ({
        id: defect.id,
        part: defect.part,
        category: defect.category,
        severity: defect.severity,
        description: defect.description,
        status: defect.status,
        outOfService: defect.outOfService,
        resolvedAt: defect.resolvedAt,
        resolutionNote: defect.resolutionNote,
        photos: await Promise.all(defect.photos.map((photo) => this.toPhotoShape(photo))),
      })),
    );
    return {
      id: dvir.id,
      driverId: dvir.driverId,
      vehicleId: dvir.vehicleId,
      trailerId: dvir.trailerId,
      type: dvir.type,
      submittedAt: dvir.submittedAt,
      odometerMi: dvir.odometerMi,
      // MR-14 — also returned when only a place name was captured (no GPS fix); lat/lon are then null.
      location:
        dvir.latitude !== null || dvir.longitude !== null || dvir.locationName
          ? { lat: dvir.latitude === null ? null : Number(dvir.latitude), lon: dvir.longitude === null ? null : Number(dvir.longitude), name: locationTextOf(dvir) }
          : null,
      trailerNumber: dvir.trailer?.number ?? dvir.trailerNumber ?? null,
      vehicleCondition: dvir.vehicleCondition,
      notes: dvir.notes,
      repairStatus: dvir.repairStatus,
      driverSignature: { key: dvir.driverSignatureUrl, url: driverSignatureUrl, hash: dvir.driverSignatureHash },
      mechanicSignature: dvir.mechanicSignedAt
        ? {
            name: dvir.mechanicName,
            signedAt: dvir.mechanicSignedAt,
            note: dvir.mechanicNote,
            // MR-10 — the signature image captured in the app (null for back-office sign-offs without one).
            key: dvir.mechanicSignatureUrl,
            url: dvir.mechanicSignatureUrl ? await this.storage.presignGet(dvir.mechanicSignatureUrl, PRESIGN_TTL_SEC) : null,
            hash: dvir.mechanicSignatureHash,
          }
        : null,
      nextDriverReviewedAt: dvir.nextDriverReviewedAt,
      defects,
      photos: await Promise.all(dvir.photos.map((photo) => this.toPhotoShape(photo))),
    };
  }

  private async toPhotoShape(photo: Attachment) {
    return { id: photo.id, url: await this.storage.presignGet(photo.key, PRESIGN_TTL_SEC), mimeType: photo.mimeType, sizeBytes: photo.sizeBytes };
  }
}

function toSummaryShape(dvir: Dvir & { _count: { defects: number }; trailer: { number: string } | null }) {
  return {
    id: dvir.id,
    vehicleId: dvir.vehicleId,
    type: dvir.type,
    submittedAt: dvir.submittedAt,
    vehicleCondition: dvir.vehicleCondition,
    defectCount: dvir._count.defects,
    repairStatus: dvir.repairStatus,
    // MR-14 (additive)
    trailerNumber: dvir.trailer?.number ?? dvir.trailerNumber ?? null,
    odometerMi: dvir.odometerMi,
  };
}
