import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import { DeviceConfigQueryDto, ReportDeviceMacDto } from './dto/mobile-device.dto';
import { DeviceConfigResponse, DeviceMacReportResponse } from './dto/mobile.responses';
import { MobileDeviceService } from './mobile-device.service';

/**
 * MG-BLE-1/2 (D-128) — the driver app reports the BLE MAC it observed on the PT30 of its selected
 * unit. Pairing (device <-> vehicle) is back-office only: `POST /devices/:id/pair`, `PATCH /devices/:id`.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/device')
export class MobileDeviceController {
  constructor(private readonly service: MobileDeviceService) {}

  @Post('mac')
  @HttpCode(200)
  @ApiOperation({
    summary: 'MG-BLE-1/2 — report the BLE MAC observed on the ELD bound to the selected vehicle.',
    description:
      '`deviceId` must be the device bound to the driver\'s selected vehicle (`bootstrap.device.id` / `select-vehicle` response `device.id`). ' +
      'Stored MAC empty -> written and audited (`outcome:"STORED"`); equal (any spelling) -> no-op (`outcome:"UNCHANGED"`, safe to replay); ' +
      'different, or the MAC is already on another device -> 409 `DEVICE_MAC_MISMATCH`, audited, back office alerted (`alert.device_mac_mismatch`). ' +
      '`macAddress` accepts `AA:BB:CC:DD:EE:FF`, `aa-bb-cc-dd-ee-ff` or `AABBCCDDEEFF`; it is stored upper-case with colons. ' +
      'The app can never pair, unpair or re-bind a device.',
  })
  @ApiBody({ schema: { example: { deviceId: '0b6f1c2e-0000-4000-8000-000000000101', macAddress: 'A4:C1:38:5E:A8:6E' } } })
  @ApiEnvelopeResponse(DeviceMacReportResponse, {
    example: { deviceId: '0b6f1c2e-0000-4000-8000-000000000101', macAddress: 'A4:C1:38:5E:A8:6E', outcome: 'STORED' },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found, or it is not the ELD bound to your selected vehicle.'),
      apiError.fieldConflicts([
        { code: ERROR_CODES.DEVICE_MAC_MISMATCH, field: 'deviceId', message: 'The device on record has a different BLE MAC (or the MAC is on another device).' },
        { code: ERROR_CODES.NO_ASSIGNED_VEHICLE, field: 'vehicle', message: 'No vehicle is selected.' },
      ]),
      apiError.validation('macAddress is not a BLE MAC address.'),
    ],
  })
  reportMac(@Body(zodBody(ReportDeviceMacDto)) dto: ReportDeviceMacDto, @CurrentUser() actor: ContextUser) {
    return this.service.reportMac(actor, dto);
  }
}

/**
 * PT SDK 6.11 (D-135) — system variables the app writes to the PT30/PT40 (`SetSystemVar`).
 * Also returned by every `POST /ingest/device-status`, so the app can re-apply on a heartbeat.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile')
export class MobileDeviceConfigController {
  constructor(private readonly service: MobileDeviceService) {}

  @Get('device-config')
  @ApiOperation({
    summary: 'PT SDK 6.11 — device config (system variables) for the ELD the driver is connected to.',
    description:
      'The device must be paired with a unit the driver is assigned to or has an open login session on (same rule as /ingest/*). ' +
      'Apply every `systemVars` entry that differs from the device; re-apply when `configVersion` changes.',
  })
  @ApiQuery({ name: 'serial', required: true, example: 'PT30_A86E' })
  @ApiEnvelopeResponse(DeviceConfigResponse, {
    example: {
      serial: 'PT30_A86E',
      model: 'PT30',
      systemVars: { PERIODIC_EVENT_GAP: 30, PERIODIC_EVENT_GAP_NOBLE: 30, EVENTS_STORED: 1, DRIVING_ACCL: 0, DRIVING_BRAKING: 450, DRIVING_CORNERING: 0, HSI_MODE: 1 },
      autoFirmware: true,
      shareDiagnostics: true,
      configVersion: '3f9a1c0b7d2e',
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.UNKNOWN_DEVICE, 'Unknown device serial.'),
      apiError.forbidden('Device is not paired with any unit, or the driver is not associated with its unit.'),
      apiError.validation('serial is required.'),
    ],
  })
  config(@Query(zodBody(DeviceConfigQueryDto)) query: DeviceConfigQueryDto, @CurrentUser('id') driverId: string) {
    return this.service.deviceConfig(driverId, query.serial);
  }
}
