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
  @ApiOperation({
    summary: 'Driver-initiated duty status change from the app (OFF/SB/ON). Works offline, queued via /mobile/sync.',
    description:
      'MR-6 — optional `locationName` (5-60 chars, §395 Appendix A manual location) is accepted WITHOUT lat/lon and is ' +
      'shown as the record location in `GET /mobile/logs` (`locationName` / `locationDescription`).\n\n' +
      'MR-23 — `specialCondition: "PC"` with `status: "OFF"` (personal conveyance) or `"YM"` with `status: "ON"` ' +
      '(yard move) appends an Appendix A eventType 3 record (code 1 / 2) next to the duty record. Allowed only when the ' +
      "driver's exception is enabled (`allowPersonalConveyance` / `allowYardMove`), else 422 SPECIAL_CONDITION_NOT_ALLOWED. " +
      'A plain status while PC/YM is in force ends it (eventType 3 code 0). A PC position is stored at 10-mile precision.\n\n' +
      'MR-13 — when `odometerMi` / `engineHours` are omitted, the unit’s last recorded reading at or before `startAt` is stored.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'evt_9101',
        status: 'OFF',
        specialCondition: 'PC',
        locationName: 'Columbus, OH',
        startAt: '2026-09-11T15:41:00.000Z',
        recordOrigin: 2,
        recordStatus: 1,
        applied: true,
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      {
        ...apiError.unprocessable(ERROR_CODES.DRIVING_TIME_IMMUTABLE, 'Driving status can only come from the ELD device, never a manual app entry.'),
        description:
          '422 — one of: DRIVING_TIME_IMMUTABLE; SPECIAL_CONDITION_NOT_ALLOWED (details.exception); ' +
          'VALIDATION_FAILED (PC needs OFF, YM needs ON, `locationName` 5-60 chars).',
      },
    ],
  })
  change(@Body(zodBody(DutyStatusDto)) dto: DutyStatusDto, @CurrentUser() actor: ContextUser) {
    return this.logs.createLogEntry(actor.id, { ...dto, annotation: dto.annotation ?? DEFAULT_DUTY_STATUS_ANNOTATION }, actor);
  }
}
