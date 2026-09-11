import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DEFAULT_DUTY_STATUS_ANNOTATION, DutyStatusDto } from './dto/mobile.dto';
import { LogsService } from '../logs/logs.service';

/**
 * TZ §11.8 / §13.2 — `POST /mobile/duty-status`, the in-app status button (no PT30 batch
 * involved). Delegates straight to `LogsService.createLogEntry` (§9.3): same immutability
 * rule, same certification invalidation, same audit trail — a status button tap and a
 * "self-edit" are the same §395 record shape (`recordOrigin = 2`), so there is exactly one
 * place that decides what a driver may and may not do to their own log.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileDutyStatusController {
  constructor(private readonly logs: LogsService) {}

  @Post('duty-status')
  @ApiOperation({ summary: 'Driver-initiated duty status change from the app (OFF/SB/ON). Works offline, queued via /mobile/sync.' })
  @ApiCreatedResponse({
    schema: {
      example: { id: 'evt_9101', status: 'ON', startAt: '2026-09-11T15:41:00.000Z', recordOrigin: 2, recordStatus: 1, applied: true },
    },
  })
  @ApiStandardErrors({
    errors: [apiError.unprocessable(ERROR_CODES.DRIVING_TIME_IMMUTABLE, 'Driving status can only come from the ELD device, never a manual app entry.')],
  })
  change(@Body(zodBody(DutyStatusDto)) dto: DutyStatusDto, @CurrentUser() actor: ContextUser) {
    return this.logs.createLogEntry(actor.id, { ...dto, annotation: dto.annotation ?? DEFAULT_DUTY_STATUS_ANNOTATION }, actor);
  }
}
