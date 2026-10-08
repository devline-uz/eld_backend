import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { SyncRequestDto } from './dto/mobile.dto';
import { MobileSyncService } from './mobile-sync.service';

/**
 * TZ §11.8 / §13.4 — `POST /mobile/sync`. Driver token only. Batch max 500 changes / 1 MB
 * (§13.4); every change is idempotent by `clientId` (§13.6) and lands in `accepted` or
 * `rejected` — never silently dropped.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileSyncController {
  constructor(private readonly syncService: MobileSyncService) {}

  @Post('sync')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Applies a batch of offline-queued changes (§13.4): duty_status, log_entry, certify, dvir.',
    description:
      'Per-change outcomes: every `clientId` lands in `accepted` or `rejected` (never dropped; replays idempotent).\n\n' +
      '`duty_status` / `log_entry` payloads accept `locationName` (5-60 chars, no lat/lon needed — MR-6), ' +
      '`specialCondition` PC|YM (MR-23, gated by driver exceptions) and `engineHours`.\n\n' +
      'MR-25 shared tablet — optional `driverId` on a change: applied to that driver only for `duty_status` / ' +
      '`log_entry`, and only if the two drivers shared one unit at `occurredAt` (a co-driver pairing on it, or both ' +
      'logged in to it per their ELD login records, eventType 5); otherwise ' +
      'that change alone is rejected with `SYNC_DELEGATION_NOT_ALLOWED`. Delegated changes are audited ' +
      '(`SYNC_DELEGATED_CHANGE`); certification and DVIR are never delegated.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        accepted: ['uuid1'],
        rejected: [{ clientId: 'uuid3', code: 'DRIVING_TIME_IMMUTABLE' }, { clientId: 'uuid4', code: 'SYNC_DELEGATION_NOT_ALLOWED' }],
        serverChanges: [],
        serverTime: '2026-09-11T15:41:00.000Z',
        hosEngineVersion: '1.0.1',
        nextSyncAfterSec: 60,
      },
    },
  })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.SYNC_BATCH_TOO_LARGE, 'Batch exceeds 500 changes or 1 MB.')] })
  sync(@Body(zodBody(SyncRequestDto)) dto: SyncRequestDto, @CurrentUser() actor: ContextUser) {
    return this.syncService.sync(actor.id, dto, actor);
  }
}
