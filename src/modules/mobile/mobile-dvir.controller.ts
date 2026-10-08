import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DvirSubmitDto, SignatureUploadDto } from './dto/mobile.dto';
import { DvirSubmitResponse, SignatureUploadResponse } from './dto/mobile.responses';
import { MobileDvirService } from './mobile-dvir.service';

/**
 * TZ §11.8 / §13.2 — `POST /mobile/dvir` and `POST /mobile/signature`. Driver token only.
 * Offline: the app queues the whole submission (including the signature bytes) and replays it
 * through `POST /mobile/sync` once connectivity returns (§13.2, §13.6).
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileDvirController {
  constructor(private readonly dvir: MobileDvirService) {}

  @Post('signature')
  @ApiOperation({ summary: 'Uploads captured signature/photo bytes to object storage; returns an id referenced by /mobile/dvir or /mobile/certify. purpose = DVIR_PHOTO also creates an Attachment row (attachmentId) to pass in defects[].photoAttachmentIds (MB-6). M-39: purpose = INVOICE accepts application/pdf (max 10 MiB, `%PDF-` header verified; PNG/JPEG 2 MB) and creates an Attachment (kind INVOICE) whose id is `invoiceAttachmentId` of POST /mobile/maintenance/:id/submit; the uploader reads it back with GET /attachments/:id/presign.' })
  @ApiEnvelopeResponse(SignatureUploadResponse, {
    status: 201,
    description: '`attachmentId` is the Attachment id for purpose DVIR_PHOTO and INVOICE (equal to `signatureImageId`), null for signatures.',
    example: { signatureImageId: '9c2a0f4e-0000-4000-8000-000000000031', attachmentId: '9c2a0f4e-0000-4000-8000-000000000031', key: 'invoices/drv_1/9c2a0f4e-0000-4000-8000-000000000031.pdf', sha256: 'a1b2...', sizeBytes: 182044 },
  })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'The base64 payload decoded to zero bytes, application/pdf with a purpose other than INVOICE, or bytes without a %PDF- header.')] })
  uploadSignature(@Body(zodBody(SignatureUploadDto)) dto: SignatureUploadDto, @CurrentUser('id') driverId: string) {
    return this.dvir.uploadSignature(driverId, dto);
  }

  @Post('dvir')
  @ApiOperation({
    summary: 'Driver DVIR submission: inspection, defects and the driver signature (+ optional mechanic name/signature).',
    description:
      'MR-9: `defects[].category` should be a `code` from `GET /mobile/defect-catalog` (unknown values are still accepted and stored as sent). ' +
      'MR-10: optional `mechanicName`, `mechanicSignatureBase64`, `mechanicSignatureMimeType` (PNG/JPEG, 2 MB; a signature needs the name). ' +
      'MR-11: `odometerMi` is optional (falls back to the unit odometer when known). `clientId` makes a replay return the first answer (409 if spent on another operation). ' +
      'D-129: optional `trailerNumber` (free text, trimmed + upper-cased, 1-10 chars `[A-Z0-9-]`, Appendix A 7.42) is stored as typed and linked to an ACTIVE carrier trailer when it matches — never 422; an explicit `trailerId` must still exist.',
  })
  @ApiEnvelopeResponse(DvirSubmitResponse, {
    status: 201,
    example: { id: 'dvir_1', driverId: 'drv_1', vehicleId: 'veh_1', trailerId: null, trailerNumber: 'X53-1188', type: 'PRE_TRIP', submittedAt: '2026-10-08T12:00:00.000Z', vehicleCondition: 'DEFECTS_FOUND', defectCount: 1, photoCount: 2, outOfService: false, signatureImageId: 'sig_9c2a', mechanicSignatureImageId: null, applied: true },
  })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'clientId already used by another operation.'), apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'), apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'photoAttachmentIds must reference this driver\'s own, not yet attached DVIR_PHOTO uploads (MB-6); mechanicName is required with mechanicSignatureBase64.'), apiError.unprocessable(ERROR_CODES.TRAILER_NOT_FOUND, 'trailerId is unknown, or names a trailer deleted before this inspection.')] })
  submit(@Body(zodBody(DvirSubmitDto)) dto: DvirSubmitDto, @CurrentUser() actor: ContextUser) {
    return this.dvir.submitIdempotent(actor.id, dto, actor);
  }
}
