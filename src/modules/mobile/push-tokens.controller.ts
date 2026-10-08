import { Body, Controller, Delete, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DeletedResponse, PushTokenResponse } from './dto/mobile.responses';
import { RegisterPushTokenDto } from './dto/push-tokens.dto';
import { PushTokensService } from './push-tokens.service';

/**
 * TZ §14 — MB-1. `PushToken` lives in its own table (never a `Driver` column) because one
 * driver carries a phone and a tablet at once; push fans out to every active token.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/push-tokens')
export class PushTokensController {
  constructor(private readonly service: PushTokensService) {}

  @Post()
  @ApiOperation({ summary: 'Registers/refreshes an FCM token for this driver\'s device (upsert by token; re-owned if it moved devices).' })
  @ApiEnvelopeResponse(PushTokenResponse, {
    status: 201,
    example: { id: 'pt_1', driverId: 'drv_1', token: 'fcm-token...', platform: 'IOS', deviceLabel: 'iPhone 15', lastSeenAt: '2026-09-21T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' },
  })
  @ApiStandardErrors()
  register(@Body(zodBody(RegisterPushTokenDto)) dto: RegisterPushTokenDto, @CurrentUser('id') driverId: string) {
    return this.service.register(driverId, dto);
  }

  @Delete(':token')
  @ApiOperation({ summary: 'Deletes this device\'s push token — only if it belongs to the calling driver.' })
  @ApiEnvelopeResponse(DeletedResponse, { example: { deleted: true } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Push token not found for this driver.')] })
  remove(@Param('token') token: string, @CurrentUser('id') driverId: string) {
    return this.service.remove(driverId, token);
  }
}
