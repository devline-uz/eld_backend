import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import {
  CreateDeviceDto,
  DeviceListQueryDto,
  ImportDevicesDto,
  PairDeviceDto,
  UpdateBleStatusDto,
  UpdateDeviceDto,
  UpdateFirmwareDto,
} from './dto/devices.dto';
import { DevicesService } from './devices.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** TZ §5.4 — "Settings > ELD devices" Figma screen (registry, firmware, heartbeats), gated by `devices`. */
@FigmaScreen('web/settings-eld-devices')
@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @Perm('devices', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'bleState', required: false })
  @ApiOperation({ summary: 'Lists PT30/PT40 devices with connected/offline BLE state and firmware.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'dev_1', serial: 'PT30_A86E', model: 'PT30', bleState: 'CONNECTED', firmwareOutdated: false }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(DeviceListQueryDto)) query: DeviceListQueryDto) {
    return this.devices.list(query);
  }

  @Get('export')
  @Perm('devices', 'READ')
  @ApiOperation({ summary: 'Exports all devices as the same shape `POST /devices/import` accepts.' })
  @ApiOkResponse({ description: 'Every device in the import payload shape.', schema: { example: { devices: [{ serial: 'PT30_A86E', model: 'PT30', bleMac: 'A4:C1:38:12:9F:6E', firmwareVersion: 'L108' }] } } })
  @ApiStandardErrors()
  export() {
    return this.devices.exportAll();
  }

  @Get(':id')
  @Perm('devices', 'READ')
  @ApiOperation({ summary: 'Gets one device.' })
  @ApiOkResponse({ schema: { example: { id: 'dev_1', serial: 'PT30_A86E', model: 'PT30', status: 'ASSIGNED', vehicleId: 'veh_1', bleState: 'CONNECTED', firmwareVersion: 'L108', firmwareOutdated: false, lastHeartbeatAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found.')] })
  get(@Param('id') id: string) {
    return this.devices.get(id);
  }

  @Post()
  @Perm('devices', 'FULL')
  @Audit({ object: 'Device', action: 'REGISTER' })
  @ApiOperation({ summary: 'Registers a PT30/PT40 device (TZ §5.4).' })
  @ApiCreatedResponse({ schema: { example: { id: 'dev_9', serial: 'PT30_1C4F', model: 'PT30', status: 'UNASSIGNED', bleState: 'DISCONNECTED' } } })
  @ApiStandardErrors({ errors: [apiError.conflict(ERROR_CODES.CONFLICT, 'A device with this serial is already registered.')] })
  create(@Body(zodBody(CreateDeviceDto)) dto: CreateDeviceDto) {
    return this.devices.create(dto);
  }

  @Post('import')
  @Perm('devices', 'FULL')
  @Audit({ object: 'Device', action: 'IMPORT' })
  @ApiOperation({ summary: 'Bulk-imports devices; upserts by `serial`.' })
  @ApiCreatedResponse({ schema: { example: { imported: 5, updated: 1, failed: [] } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.IMPORT_FAILED, 'One or more rows could not be imported.')] })
  import(@Body(zodBody(ImportDevicesDto)) dto: ImportDevicesDto) {
    return this.devices.importMany(dto);
  }

  @Patch(':id')
  @Perm('devices', 'FULL')
  @Audit({ object: 'Device', action: 'UPDATE' })
  @ApiOperation({ summary: 'Edits a device (BLE MAC, PE/PN settings, status).' })
  @ApiOkResponse({ schema: { example: { id: 'dev_1', serial: 'PT30_A86E', bleMac: 'A4:C1:38:12:9F:6E', status: 'ASSIGNED' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found.')] })
  update(@Param('id') id: string, @Body(zodBody(UpdateDeviceDto)) dto: UpdateDeviceDto) {
    return this.devices.update(id, dto);
  }

  @Patch(':id/firmware')
  @Perm('devices', 'FULL')
  @Audit({ object: 'Device', action: 'UPDATE_FIRMWARE' })
  @ApiOperation({ summary: 'Records a firmware version reported by the device (warns below L108, TZ §5.4).' })
  @ApiOkResponse({ description: '`firmwareOutdated` is true below L108 (TZ §5.4).', schema: { example: { id: 'dev_1', firmwareVersion: 'L107', firmwareOutdated: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found.')] })
  updateFirmware(@Param('id') id: string, @Body(zodBody(UpdateFirmwareDto)) dto: UpdateFirmwareDto) {
    return this.devices.updateFirmware(id, dto);
  }

  @Patch(':id/ble-status')
  @Perm('devices', 'FULL')
  @ApiOperation({ summary: 'Records the BLE connection state reported by the app (CONNECTED/OUT_OF_RANGE/DISCONNECTED).' })
  @ApiOkResponse({ schema: { example: { id: 'dev_1', bleState: 'OUT_OF_RANGE', lastHeartbeatAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found.')] })
  updateBleStatus(@Param('id') id: string, @Body(zodBody(UpdateBleStatusDto)) dto: UpdateBleStatusDto) {
    return this.devices.updateBleStatus(id, dto);
  }

  @Delete(':id')
  @Perm('devices', 'FULL')
  @Audit({ object: 'Device', action: 'DELETE' })
  @ApiOperation({ summary: 'Retires a device (status -> RETIRED, unpaired). Never hard-deletes — see bugs.md B-009.' })
  @ApiOkResponse({ description: 'Retired, never hard-deleted (bugs.md B-009).', schema: { example: { id: 'dev_1', status: 'RETIRED', vehicleId: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found.')] })
  remove(@Param('id') id: string) {
    return this.devices.remove(id);
  }

  @Post(':id/pair')
  @Perm('devices', 'FULL')
  @Audit({ object: 'Device', action: 'PAIR' })
  @ApiOperation({ summary: 'Pairs a device to a unit. One device per unit (hard rule).' })
  @ApiCreatedResponse({ schema: { example: { id: 'dev_1', serial: 'PT30_A86E', status: 'ASSIGNED', vehicleId: 'veh_1' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found.'), apiError.conflict(ERROR_CODES.DEVICE_ALREADY_PAIRED, 'This unit already has a paired device — one device per unit.')] })
  pair(@Param('id') id: string, @Body(zodBody(PairDeviceDto)) dto: PairDeviceDto) {
    return this.devices.pair(id, dto);
  }

  @Post(':id/unpair')
  @Perm('devices', 'FULL')
  @Audit({ object: 'Device', action: 'UNPAIR' })
  @ApiOperation({ summary: 'Unpairs a device from its unit.' })
  @ApiCreatedResponse({ schema: { example: { id: 'dev_1', serial: 'PT30_A86E', status: 'UNASSIGNED', vehicleId: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DEVICE_NOT_FOUND, 'Device not found.')] })
  unpair(@Param('id') id: string) {
    return this.devices.unpair(id);
  }
}
