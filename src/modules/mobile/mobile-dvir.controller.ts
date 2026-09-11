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
  @ApiOperation({ summary: 'Uploads captured signature/photo bytes to object storage; returns an id referenced by /mobile/dvir or /mobile/certify.' })
  @ApiCreatedResponse({ schema: { example: { signatureImageId: 'sig_9c2a', key: 'signatures/drv_1/sig_9c2a.png', sha256: 'a1b2...', sizeBytes: 4821 } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'The base64 payload decoded to zero bytes.')] })
  uploadSignature(@Body(zodBody(SignatureUploadDto)) dto: SignatureUploadDto, @CurrentUser('id') driverId: string) {
    return this.dvir.uploadSignature(driverId, dto);
  }

  @Post('dvir')
  @ApiOperation({ summary: 'Driver DVIR submission: inspection, defects and the driver signature.' })
  @ApiCreatedResponse({
    schema: {
      example: { id: 'dvir_1', vehicleId: 'veh_1', type: 'PRE_TRIP', vehicleCondition: 'DEFECTS_FOUND', defectCount: 1, outOfService: false, applied: true },
    },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  submit(@Body(zodBody(DvirSubmitDto)) dto: DvirSubmitDto, @CurrentUser() actor: ContextUser) {
    return this.dvir.submit(actor.id, dto, actor);
  }
}
