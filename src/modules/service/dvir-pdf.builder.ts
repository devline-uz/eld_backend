import { Inject, Injectable } from '@nestjs/common';
import type { Attachment, Defect, Dvir } from '@prisma/client';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { renderPdf } from '../reports/lib/pdf-render';

/** TZ §17 — presigned GET default TTL (15 min); this PDF is generated and returned inline in
 * the same request, so a short-lived signature on the embedded image URLs is correct — the
 * PDF bytes themselves, not the signed image URLs, are what the caller keeps. */
const IMAGE_PRESIGN_TTL_SEC = 15 * 60;

export type DvirForPdf = Dvir & {
  defects: (Defect & { photos: Attachment[] })[];
  photos: Attachment[];
  driver: { firstName: string; lastName: string; cdlNumber: string } | null;
  vehicle: { unitNumber: string; vin: string; licensePlate: string | null; plateState: string | null } | null;
  trailer: { number: string } | null;
};

/**
 * B-75 — `GET /dvir/:id/pdf`. Renders ONE DVIR to a §396.11-shaped PDF: inspection header,
 * the defect list, the §396.13 mechanic review, and both signatures (the driver's captured
 * signature image plus the mechanic's name/timestamp attestation — `Dvir` has no second image
 * field, mechanic sign-off is text-only by design, see decisions.md). Reuses the same
 * `renderPdf` Puppeteer helper `FmcsaPackGenerator` uses (TZ §15 "PDF: Puppeteer, templates in
 * reports/templates/") — this is not a second PDF pipeline, just a second template.
 */
@Injectable()
export class DvirPdfBuilder {
  constructor(@Inject(STORAGE_PORT) private readonly storage: StoragePort) {}

  async build(dvir: DvirForPdf): Promise<Buffer> {
    const driverSignatureUrl = await this.storage.presignGet(dvir.driverSignatureUrl, IMAGE_PRESIGN_TTL_SEC);

    const defects = dvir.defects.map((d) => ({
      part: d.part,
      category: d.category,
      severity: d.severity,
      description: d.description,
      status: d.status,
      outOfService: d.outOfService ? 'YES' : 'NO',
    }));

    return renderPdf('dvir-single', {
      dvirId: dvir.id,
      type: dvir.type,
      submittedAt: dvir.submittedAt.toISOString(),
      driverName: dvir.driver ? `${dvir.driver.lastName}, ${dvir.driver.firstName}` : dvir.driverId,
      driverCdl: dvir.driver?.cdlNumber ?? '',
      vehicleUnit: dvir.vehicle?.unitNumber ?? dvir.vehicleId,
      vehicleVin: dvir.vehicle?.vin ?? '',
      trailerUnit: dvir.trailer?.number ?? '—',
      odometerMi: dvir.odometerMi,
      locationName: dvir.locationName ?? '',
      vehicleCondition: dvir.vehicleCondition,
      repairStatus: dvir.repairStatus,
      notes: dvir.notes ?? '',
      defectCount: defects.length,
      defects,
      mechanicName: dvir.mechanicName ?? '—',
      mechanicSignedAt: dvir.mechanicSignedAt ? dvir.mechanicSignedAt.toISOString() : '—',
      mechanicNote: dvir.mechanicNote ?? '',
      nextDriverReviewedAt: dvir.nextDriverReviewedAt ? dvir.nextDriverReviewedAt.toISOString() : '—',
      driverSignatureUrl,
    });
  }
}
