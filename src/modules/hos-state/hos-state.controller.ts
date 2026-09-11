import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { HosStateDto } from './dto/hos-state.dto';
import { HosStateService, type HosStateSubmitResult } from './hos-state.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';

/**
 * TZ §8.6 point 5 / §11.8 — `POST /v1/mobile/hos-state`.
 *
 * The app computes HOS offline (that is the whole point of the Dart engine) and posts what it
 * got. The server stores it in `DriverHosSnapshot`, compares it with its OWN calculation and
 * answers with the authoritative numbers plus the measured drift. Driver token only: a
 * back-office user has no HOS state of their own.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class HosStateController {
  constructor(private readonly hosState: HosStateService) {}

  @Post('hos-state')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Receives the HOS state computed by the mobile engine, stores it and compares it with the server (§8.6).',
  })
  @ApiOkResponse({
    description:
      'Stored. `versionMismatch: true` means the comparison was skipped because the app runs a different HOS_ENGINE_VERSION — the app must show the "update the app" banner. `drift: true` means the server raised `alert.hos_engine_drift`.',
    schema: {
      example: {
        accepted: true,
        engineVersion: '1.0.1',
        versionMismatch: false,
        drift: false,
        server: { driveRemainingSec: 0, shiftRemainingSec: 1140, cycleRemainingSec: 46140, breakRemainingSec: 7440 },
        deltasSec: { driveRemainingSec: 0, shiftRemainingSec: 0, cycleRemainingSec: 0, breakRemainingSec: 0 },
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('DRIVER_CONTEXT_REQUIRED — this endpoint accepts a driver token only.'),
      apiError.unprocessable(ERROR_CODES.HOS_ENGINE_VERSION_MISMATCH, 'The posted HOS engine version is not comparable with the server engine.'),
    ],
  })
  async hosStateSubmit(
    @Body(zodBody(HosStateDto)) dto: HosStateDto,
    @CurrentUser('id') driverId: string,
  ): Promise<HosStateSubmitResult> {
    return this.hosState.submit(driverId, dto);
  }
}
