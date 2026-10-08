import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { HosStateDto } from './dto/hos-state.dto';
import { HosStateService, type HosStateSubmitResult } from './hos-state.service';
import { apiError, ApiStandardErrors } from '../../common/errors';

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
      'Stored. The server state is computed AT `computedAt` (MR-1), not at request time. `compared: false` comes with `reason`: `VERSION_MISMATCH` (the app runs a different HOS_ENGINE_VERSION — never a drift alert; `updateRequired: true` when the app engine is older than the server engine, show the "update the app" banner) or `STALE` (`computedAt` is more than 3600 s old; `staleSec` says how old — no drift alert is raised). `drift: true` means the server raised `alert.hos_engine_drift`. `serverState` carries the MR-24 timestamps (`statusSince`, `nextBreakDueAt`, `shiftEndsAt`, `cycleRecapAt`, `restartAvailableAt`; ISO-8601 or null).',
    schema: {
      type: 'object',
      required: ['hosEngineVersion', 'accepted', 'versionMismatch', 'updateRequired', 'compared', 'drift', 'maxDriftSec', 'fields', 'statusMismatch', 'serverState', 'driftThresholdSec'],
      properties: {
        hosEngineVersion: { type: 'string', example: '1.0.3' },
        accepted: { type: 'boolean', enum: [true] },
        versionMismatch: { type: 'boolean' },
        updateRequired: { type: 'boolean', description: 'True only with `reason: "VERSION_MISMATCH"` when the app engine is OLDER than `hosEngineVersion`.' },
        compared: { type: 'boolean' },
        reason: { type: 'string', enum: ['STALE', 'VERSION_MISMATCH'], description: 'MR-1 — present only when `compared` is false.' },
        staleSec: { type: 'integer', description: 'MR-1 — with `reason: "STALE"`: age of `computedAt` in seconds.' },
        drift: { type: 'boolean' },
        maxDriftSec: { type: 'integer', nullable: true },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              serverSec: { type: 'integer' },
              appSec: { type: 'integer' },
              diffSec: { type: 'integer' },
            },
          },
        },
        statusMismatch: { type: 'boolean' },
        serverState: {
          type: 'object',
          nullable: true,
          properties: {
            currentStatus: { type: 'string', enum: ['OFF', 'SB', 'D', 'ON'] },
            driveRemainingSec: { type: 'integer' },
            shiftRemainingSec: { type: 'integer' },
            breakRemainingSec: { type: 'integer' },
            cycleRemainingSec: { type: 'integer' },
            dailyTotals: {
              type: 'object',
              properties: { off: { type: 'integer' }, sb: { type: 'integer' }, drive: { type: 'integer' }, on: { type: 'integer' } },
            },
            violations: {
              type: 'array',
              items: { type: 'object', properties: { type: { type: 'string' }, exceededBySec: { type: 'integer' } } },
            },
            statusSince: { type: 'string', format: 'date-time', description: 'MR-24 — when the current duty status started.' },
            nextBreakDueAt: { type: 'string', format: 'date-time', nullable: true, description: 'MR-24 — when the 30-minute break is due (while driving or overdue), else null.' },
            shiftEndsAt: { type: 'string', format: 'date-time', nullable: true, description: 'MR-24 — when the 14-hour window ends; null with no open shift. Passenger rulesets (§395.5(a)(2), 15 h ON DUTY): now + remaining on-duty time.' },
            cycleRecapAt: { type: 'string', format: 'date-time', nullable: true, description: 'MR-24 — the next home-terminal midnight at which recap hours come back (first upcoming day boundary whose departing day had on-duty time, B-133); null when the whole cycle window is empty.' },
            restartAvailableAt: { type: 'string', format: 'date-time', nullable: true, description: 'MR-24 — while OFF/SB: when the current rest reaches 34 h; else null. Always null on passenger rulesets (no restart, §395.3(c)).' },
          },
        },
        driftThresholdSec: { type: 'integer', example: 60 },
        message: { type: 'string' },
      },
      example: {
        hosEngineVersion: '1.0.3',
        accepted: true,
        versionMismatch: false,
        updateRequired: false,
        compared: true,
        drift: false,
        maxDriftSec: 0,
        fields: [],
        statusMismatch: false,
        serverState: {
          currentStatus: 'D',
          driveRemainingSec: 3600,
          shiftRemainingSec: 7200,
          breakRemainingSec: 1800,
          cycleRemainingSec: 36000,
          dailyTotals: { off: 3600, sb: 0, drive: 36000, on: 1800 },
          violations: [],
          statusSince: '2026-10-08T13:00:00.000Z',
          nextBreakDueAt: '2026-10-08T15:30:00.000Z',
          shiftEndsAt: '2026-10-08T17:00:00.000Z',
          cycleRecapAt: null,
          restartAvailableAt: null,
        },
        driftThresholdSec: 60,
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('DRIVER_CONTEXT_REQUIRED — this endpoint accepts a driver token only.'),
    ],
  })
  async hosStateSubmit(
    @Body(zodBody(HosStateDto)) dto: HosStateDto,
    @CurrentUser('id') driverId: string,
  ): Promise<HosStateSubmitResult> {
    return this.hosState.submit(driverId, dto);
  }
}
