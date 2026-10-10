import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { apiError, ApiStandardErrors } from '../../common/errors/api-error-responses.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { DeviceEventsResult, DeviceEventsService } from './device-events.service';
import {
  IngestBleStateDto,
  IngestDeviceEventsDto,
  IngestDeviceStatusDto,
  IngestEventsDto,
  IngestTelemetryDto,
  MAX_BATCH_BYTES,
} from './dto/ingest.dto';
import { IngestEventsResult, IngestService } from './ingest.service';

/**
 * TZ §7.1 — the ingest endpoints (§7.1 four + SDK 6.11 `device-events`). Every one of them is called by the mobile APP with a
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
 * `common/throttler/throttler.options.ts` (one bucket across every endpoint below), so one
 * misbehaving device can no longer spend the whole carrier NAT's budget. Do not add a named
 * `ingest` override to `@Throttle()` here — the limit is intentionally configured centrally.
 */
@ApiTags('ingest')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Throttle({ default: { limit: 400, ttl: 1000 } })
@Controller('ingest')
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly deviceEvents: DeviceEventsService,
  ) {}

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
        accepted: 118,
        duplicates: 2,
        sequenceIds: { 'drv_1': [1042, 1043] },
        warnings: [],
        malfunctions: [],
        diagnostics: [],
        unidentifiedSegmentIds: [],
        confirmationRequests: [],
      },
    },
  })
  @ApiResponse({
    status: 202,
    description:
      'ACCEPTED_WITH_WARNINGS — stored, but at least one event had a bad checksum, a drifted clock or an implausible odometer (§7.3 rules 4/5, §4.3).',
    schema: {
      example: {
        accepted: 120,
        duplicates: 0,
        sequenceIds: { 'drv_1': [1042] },
        warnings: [{ uuid: '8f14e45f-ceea-467a-9575-8b1d6b1c9f11', code: 'CHECKSUM_MISMATCH', detail: 'Checksum mismatch (expected 3A, got 1F).' }],
        malfunctions: [],
        diagnostics: ['3'],
        unidentifiedSegmentIds: [],
        confirmationRequests: [],
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
  @ApiOperation({
    summary: 'Uploads Virtual Dashboard points (app downsamples to 1/60 s, §7.5).',
    description:
      'PT SDK 6.11: `latitude`/`longitude` optional (no GPS lock — stored without a position); `loadPct` 0–250; ' +
      '`gear` int or string (stored as text); `busType` accepts `J1939|J1708|OBD_II`, `OBDII|OBD2|OBD-II` or bits 1/2/4 ' +
      '(unknown -> null); `dtcCodes[]` (max 50) carry J1939 `spn/fmi/occurrence/conversionMethod`, J1708 `code` or `spn`+`isSid`, `fmi`, `active`, ' +
      'OBD-II `code`; point `milOn` applies to them; `vin` updates `Device.reportedVin`.',
  })
  @ApiBody({
    schema: {
      example: {
        deviceSerial: 'PT30_A86E',
        vehicleId: '0b6f1c2e-0000-4000-8000-000000000201',
        points: [
          {
            time: '2026-10-10T12:00:00Z', latitude: 41.8781, longitude: -87.6298, speedKmh: 88, headingDeg: 270,
            odometerKm: 182345.6, engineHours: 5123.4, rpm: 1350, gear: 10, loadPct: 145, busType: 'J1939',
            intakePressureKpa: 180, barometerKpa: 99.1, gpsLocked: true, gpsSatellites: 9, gpsDop: 1.1, gpsAgeSec: 0,
            milOn: true, dtcCount: 1, dtcCodes: [{ spn: 100, fmi: 1, occurrence: 3, conversionMethod: 0 }], isTransition: false,
          },
          { time: '2026-10-10T12:01:00Z', latitude: null, longitude: null, gpsLocked: false, rpm: 1300, busType: 4 },
        ],
      },
    },
  })
  @ApiOkResponse({ description: 'Virtual Dashboard points; the app already downsampled to 1/60 s (§7.5).', schema: { example: { accepted: 60, duplicates: 0, denserThanContract: 0 } } })
  @ApiStandardErrors({ errors: [apiError.forbidden('DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only.')] })
  telemetry(
    @Req() req: Request,
    @Body(zodBody(IngestTelemetryDto)) dto: IngestTelemetryDto,
    @CurrentUser('id') driverId: string,
  ) {
    assertPayloadSize(req);
    return this.ingest.ingestTelemetry(dto, driverId);
  }

  @Post('device-events')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Uploads raw PT SDK TelemetryEvents (live + stored; max 500 / 1 MB, one transaction).',
    description:
      'Not §395 records (those still go to /ingest/events). `type` = SDK name (`EV_MEMS_BRK`) or enum (`HARSH_BRAKE`); unknown -> `UNKNOWN`. ' +
      'Idempotent on (device, occurredAt, seq) — the SDK ACK key. Newly stored `HARSH_ACCEL/BRAKE/CORNER` create a SafetyEvent ' +
      '(HARSH_ACCEL / HARSH_BRAKING / HARSH_TURN) and raise `alert.harsh_event`. Coordinates are coarsened before storage.',
  })
  @ApiBody({
    schema: {
      example: {
        deviceSerial: 'PT30_A86E',
        vehicleId: '0b6f1c2e-0000-4000-8000-000000000201',
        events: [
          { type: 'EV_ENGINE_ON', seq: 41, hsi: 1203, occurredAt: '2026-10-10T11:58:02Z', live: true, latitude: 41.8781, longitude: -87.6298, gpsLocked: true, gpsSatellites: 9, odometerKm: '182345.6', engineHours: '5123.4', rpm: 650 },
          { type: 'EV_MEMS_BRK', seq: 42, occurredAt: '2026-10-10T12:03:10Z', live: true, latitude: 41.88, longitude: -87.63, headingDeg: 270, speedKmh: 72, rpm: 1400 },
        ],
      },
    },
  })
  @ApiOkResponse({ description: 'Duplicates (same device + occurredAt + seq) are counted, not re-inserted.', schema: { example: { received: 2, stored: 2, duplicates: 0, safetyEvents: 1 } } })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only; or the device/unit is not yours.'),
      { status: 413, code: ERROR_CODES.PAYLOAD_TOO_LARGE, message: 'Ingest batch exceeds the 1 MB limit.', details: { bytes: 1400000, limit: 1048576 } },
    ],
  })
  deviceEventsUpload(
    @Req() req: Request,
    @Body(zodBody(IngestDeviceEventsDto)) dto: IngestDeviceEventsDto,
    @CurrentUser('id') driverId: string,
  ): Promise<DeviceEventsResult> {
    assertPayloadSize(req);
    return this.deviceEvents.ingestDeviceEvents(dto, driverId);
  }

  @Post('ble-state')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reports a BLE state transition (§7.6): CONNECTED / OUT_OF_RANGE / DISCONNECTED; optional `connectionType` BLE|USB (SDK 6.11).' })
  @FigmaScreen('web/settings-eld-devices')
  @ApiBody({ schema: { example: { deviceSerial: 'PT30_A86E', state: 'CONNECTED', at: '2026-10-10T12:00:00Z', connectionType: 'USB' } } })
  @ApiOkResponse({ description: 'BLE transition recorded; > 30 min unconnected raises alert.eld_disconnected.', schema: { example: { bleState: 'CONNECTED', connectionType: 'USB', disconnectedAlert: false } } })
  @ApiStandardErrors({ errors: [apiError.forbidden('DRIVER_CONTEXT_REQUIRED — ingest accepts a driver token only.')] })
  bleState(
    @Body(zodBody(IngestBleStateDto)) dto: IngestBleStateDto,
    @CurrentUser('id') driverId: string,
  ) {
    return this.ingest.recordBleState(dto, driverId);
  }

  @Post('device-status')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reports stored-event backlog, firmware and SDK TrackerInfo (§7.7); answers the system variables to apply.',
    description:
      '`productName` `PT40*` -> model PT40, `PT30*` -> PT30. `reportedVin` differing from the paired unit VIN -> `vinMismatch: true` ' +
      '(never blocks; `alert.device_vin_mismatch` once per new VIN). `systemVars` are the PT SDK SetSystemVar targets.',
  })
  @FigmaScreen('web/settings-eld-devices')
  @ApiBody({
    schema: {
      example: {
        deviceSerial: 'PT30_A86E', storedEventsCount: 12, mainFirmware: 'L108', bleFirmware: '1.4.2', sdkVersion: '6.11.1',
        productName: 'PT40-C', imei: '356938035643809', reportedVin: '1FUJGLDR7CLBP8834', connectionType: 'BLE', busType: 'J1939',
        appPlatform: 'ANDROID', recordsLost: false, consecutiveTransferFailures: 0,
      },
    },
  })
  @ApiOkResponse({
    description: 'Backlog recorded; > 100 stored events raises alert.device_backlog.',
    schema: {
      example: {
        storedEventsCount: 12, backlogAlert: false, codes: [], model: 'PT40', vinMismatch: false,
        systemVars: { PERIODIC_EVENT_GAP: 30, PERIODIC_EVENT_GAP_NOBLE: 30, EVENTS_STORED: 1, DRIVING_ACCL: 0, DRIVING_BRAKING: 450, DRIVING_CORNERING: 0, HSI_MODE: 1 },
        configVersion: '3f9a1c0b7d2e',
      },
    },
  })
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
