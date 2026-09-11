import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { apiError, ApiStandardErrors } from '../../common/errors/api-error-responses.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import {
  IngestBleStateDto,
  IngestDeviceStatusDto,
  IngestEventsDto,
  IngestTelemetryDto,
  MAX_BATCH_BYTES,
} from './dto/ingest.dto';
import { IngestEventsResult, IngestService } from './ingest.service';

/**
 * TZ §7.1 — the four ingest endpoints. Every one of them is called by the mobile APP with a
 * DRIVER JWT (§3.1: the PT30 has no SIM, no Wi-Fi and therefore no HTTP endpoint of its own),
 * so `DriverGuard` is mandatory — a back-office token must never post §395 events.
 *
 * Figma: "Driver app → sync" (background upload indicator) and "Settings > ELD devices"
 * (BLE state / stored-event backlog surfaced from ble-state + device-status).
 *
 * B-024 — the app-wide default throttle (600 req/min = 10 req/s, `app.module.ts`) sits an
 * order of magnitude below the §19 ingest targets (50/s sustained, 300/s peak) and a whole
 * fleet legitimately shares one egress IP behind the same depot NAT. Every driver on that
 * fleet would start seeing 429s long before the documented target is reached, so this
 * controller carries its own, much higher, ceiling (§19 peak + headroom).
 *
 * B-033 — that IP ceiling is a fleet-wide backstop only. §6.5's real ingest limit is
 * 300 req/min PER DRIVER, enforced by the `ingest` bucket in
 * `common/throttler/throttler.options.ts` (one bucket across all four endpoints below), so one
 * misbehaving device can no longer spend the whole carrier NAT's budget. Do not add a named
 * `ingest` override to `@Throttle()` here — the limit is intentionally configured centrally.
 */
@ApiTags('ingest')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Throttle({ default: { limit: 400, ttl: 1000 } })
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Post('events')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Uploads a batch of §395 ELD events from the app (max 500 events / 1 MB, one transaction).',
  })
  @ApiOkResponse({
    description: 'Stored. Duplicates by `uuid` are counted, not re-inserted.',
    schema: {
      example: {
        received: 120,
        stored: 118,
        duplicates: 2,
        unidentified: 0,
        warnings: [],
        firstEventSequenceId: 1042,
        lastEventSequenceId: 1159,
      },
    },
  })
  @ApiResponse({
    status: 202,
    description:
      'ACCEPTED_WITH_WARNINGS — stored, but at least one event had a bad checksum, a drifted clock or an implausible odometer (§7.3 rules 4/5, §4.3).',
    schema: {
      example: {
        received: 120,
        stored: 120,
        duplicates: 0,
        unidentified: 3,
        warnings: [{ uuid: '8f14e45f-ceea-467a-9575-8b1d6b1c9f11', code: 'CHECKSUM_MISMATCH', message: 'Stored as-is and flagged — a §395 record is never dropped.' }],
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only.'),
      apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Schema violation — the only reason an event is ever rejected.'),
      { status: 413, code: ERROR_CODES.PAYLOAD_TOO_LARGE, message: 'Ingest batch exceeds the 1 MB limit.', details: { bytes: 1400000, limit: 1048576 } },
    ],
  })
  async events(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(zodBody(IngestEventsDto)) dto: IngestEventsDto,
    @CurrentUser('id') driverId: string,
  ): Promise<IngestEventsResult> {
    assertPayloadSize(req);
    const result = await this.ingest.ingestEvents(dto, driverId);
    if (result.warnings.length) res.status(202);
    return result;
  }

  @Post('telemetry')
  @HttpCode(200)
  @ApiOperation({ summary: 'Uploads Virtual Dashboard points (app downsamples to 1/60 s, §7.5).' })
  @ApiOkResponse({ description: 'Virtual Dashboard points; the app already downsampled to 1/60 s (§7.5).', schema: { example: { received: 60, stored: 60, duplicates: 0 } } })
  @ApiStandardErrors({ errors: [apiError.forbidden('DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only.')] })
  telemetry(
    @Req() req: Request,
    @Body(zodBody(IngestTelemetryDto)) dto: IngestTelemetryDto,
    @CurrentUser('id') driverId: string,
  ) {
    assertPayloadSize(req);
    return this.ingest.ingestTelemetry(dto, driverId);
  }

  @Post('ble-state')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reports a BLE state transition (§7.6): CONNECTED / OUT_OF_RANGE / DISCONNECTED.' })
  @FigmaScreen('web/settings-eld-devices')
  @ApiOkResponse({ description: 'BLE transition recorded; a long OUT_OF_RANGE raises the §4.6 diagnostic.', schema: { example: { deviceId: 'dev_1', bleState: 'OUT_OF_RANGE', recordedAt: '2026-09-11T15:41:00.000Z', diagnosticRaised: false } } })
  @ApiStandardErrors({ errors: [apiError.forbidden('DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only.')] })
  bleState(
    @Body(zodBody(IngestBleStateDto)) dto: IngestBleStateDto,
    @CurrentUser('id') driverId: string,
  ) {
    return this.ingest.recordBleState(dto, driverId);
  }

  @Post('device-status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reports stored-event backlog and firmware (§7.7).' })
  @FigmaScreen('web/settings-eld-devices')
  @ApiOkResponse({ description: 'Stored-event backlog and firmware version (§7.7).', schema: { example: { deviceId: 'dev_1', storedEventCount: 12, firmwareVersion: 'L108', firmwareOutdated: false, lastHeartbeatAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.forbidden('DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only.')] })
  deviceStatus(
    @Body(zodBody(IngestDeviceStatusDto)) dto: IngestDeviceStatusDto,
    @CurrentUser('id') driverId: string,
  ) {
    return this.ingest.recordDeviceStatus(dto, driverId);
  }
}

/** §7.3 rule 2 — 1 MB ceiling, answered as 413 rather than a silent truncation. */
function assertPayloadSize(req: Request): void {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BATCH_BYTES) {
    throw new AppException(
      ERROR_CODES.PAYLOAD_TOO_LARGE,
      `Ingest batch exceeds the ${MAX_BATCH_BYTES} byte limit.`,
      413,
      { bytes: declared, limit: MAX_BATCH_BYTES },
    );
  }
}
