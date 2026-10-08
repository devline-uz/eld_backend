import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DvirSubmitDto, SignatureUploadDto } from './dto/mobile.dto';
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
  @ApiOperation({ summary: 'Uploads captured signature/photo bytes to object storage; returns an id referenced by /mobile/dvir or /mobile/certify. purpose = DVIR_PHOTO also creates an Attachment row (attachmentId) to pass in defects[].photoAttachmentIds (MB-6).' })
  @ApiCreatedResponse({ schema: { example: { signatureImageId: 'sig_9c2a', attachmentId: null, key: 'signatures/drv_1/sig_9c2a.png', sha256: 'a1b2...', sizeBytes: 4821 } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'The base64 payload decoded to zero bytes.')] })
  uploadSignature(@Body(zodBody(SignatureUploadDto)) dto: SignatureUploadDto, @CurrentUser('id') driverId: string) {
    return this.dvir.uploadSignature(driverId, dto);
  }

  @Post('dvir')
  @ApiOperation({
    summary: 'Driver DVIR submission: inspection, defects and the driver signature (+ optional mechanic name/signature).',
    description:
      'MR-9: `defects[].category` should be a `code` from `GET /mobile/defect-catalog` (unknown values are still accepted and stored as sent). ' +
      'MR-10: optional `mechanicName`, `mechanicSignatureBase64`, `mechanicSignatureMimeType` (PNG/JPEG, 2 MB; a signature needs the name). ' +
      'MR-11: `odometerMi` is optional (falls back to the unit odometer when known). `clientId` makes a replay return the first answer (409 if spent on another operation).',
  })
  @ApiCreatedResponse({
    schema: {
      example: { id: 'dvir_1', vehicleId: 'veh_1', type: 'PRE_TRIP', vehicleCondition: 'DEFECTS_FOUND', defectCount: 1, photoCount: 2, outOfService: false, mechanicSignatureImageId: null, applied: true },
    },
  })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'clientId already used by another operation.'), apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'), apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'photoAttachmentIds must reference this driver\'s own, not yet attached DVIR_PHOTO uploads (MB-6); mechanicName is required with mechanicSignatureBase64.'), apiError.unprocessable(ERROR_CODES.TRAILER_NOT_FOUND, 'trailerId is unknown, or names a trailer deleted before this inspection.')] })
  submit(@Body(zodBody(DvirSubmitDto)) dto: DvirSubmitDto, @CurrentUser() actor: ContextUser) {
    return this.dvir.submitIdempotent(actor.id, dto, actor);
  }
}
