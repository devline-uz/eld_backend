import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import {
  CreateDriverDocumentDto,
  CreateDriverDto,
  DriverListQueryDto,
  DriverRosterQueryDto,
  ImportDriversDto,
  UpdateDriverDto,
  VerifyDriverEmailDto,
} from './dto/drivers.dto';
import { DriverRosterService } from './driver-roster.service';
import { DriversService } from './drivers.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { DRIVER_CONFLICT_MESSAGES } from './lib/driver-uniques';

/** B-100 — field-level 409s on `POST /drivers` / `PATCH /drivers/:id`. */
const DRIVER_FIELD_CONFLICTS = [
  { code: ERROR_CODES.USERNAME_TAKEN, field: 'username', message: DRIVER_CONFLICT_MESSAGES.username },
  { code: ERROR_CODES.EMAIL_TAKEN, field: 'email', message: DRIVER_CONFLICT_MESSAGES.email },
  { code: ERROR_CODES.PHONE_TAKEN, field: 'phone', message: DRIVER_CONFLICT_MESSAGES.phone },
  { code: ERROR_CODES.CDL_NUMBER_TAKEN, field: 'cdlNumber', message: DRIVER_CONFLICT_MESSAGES.cdlNumber },
];

/** TZ §5.3 — "Drivers" and "Driver profile" Figma screens, gated by the `drivers` permission key. */
@FigmaScreen('web/drivers', 'web/driver-add')
@ApiTags('drivers')
@ApiBearerAuth()
@Controller('drivers')
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly roster$: DriverRosterService,
  ) {}

  @Get()
  @Perm('drivers', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiOperation({ summary: 'Lists drivers with CDL, exceptions, and status (TZ §5.3).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'drv_1', username: 'jsmith', cdlNumber: 'D1234567' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(DriverListQueryDto)) query: DriverListQueryDto) {
    return this.drivers.list(query);
  }

  @Get('export')
  @Perm('drivers', 'READ')
  @ApiOperation({ summary: 'Exports all drivers as the same shape `POST /drivers/import` accepts (round-trips without loss, minus passwords).' })
  @ApiOkResponse({ description: 'Every driver in the import payload shape.', schema: { example: { drivers: [{ username: 'jsmith', firstName: 'John', lastName: 'Smith', cdlNumber: 'W8569238', cdlState: 'OH', homeTerminalTimezone: 'America/New_York', hosRuleset: 'US_70_8_PROPERTY' }] } } })
  @ApiStandardErrors()
  export() {
    return this.drivers.exportAll();
  }

  // Static `roster` MUST stay above `:id`, or Express matches it as a driver id (404 DRIVER_NOT_FOUND).
  @Get('roster')
  @Perm('drivers', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'terminal', required: false, description: 'Exact home terminal name (case-insensitive).' })
  @ApiQuery({ name: 'hasOpenViolation', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'exempt', required: false, enum: ['true', 'false'], description: 'Filters on `eldExempt`.' })
  @ApiOperation({ summary: 'W-06 roster: per driver the HOS engine clocks, current duty status, assigned unit and open violation count.' })
  @ApiOkResponse({ schema: { example: { items: [{ driver: { id: 'drv_1', username: 'jsmith', firstName: 'John', lastName: 'Smith', homeTerminalName: 'Columbus, OH', appVersion: 'v2.24', email: 'john@example.com', eldExempt: false, allowPersonalConveyance: true, allowYardMove: true, shortHaulException: false, splitSleeperEnabled: false }, dutyStatus: 'DRIVING', unit: { id: 'veh_1', unitNumber: '101' }, hos: { driveRemainingSec: 16200, shiftRemainingSec: 20400, cycleRemainingSec: 252000 }, openViolations: 0, emailVerified: null }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  roster(@Query(zodBody(DriverRosterQueryDto)) query: DriverRosterQueryDto) {
    return this.roster$.roster(query);
  }

  @Get(':id/hos')
  @Perm('hos', 'READ')
  @ApiOperation({ summary: 'The four HOS clocks for one driver, computed now by the HOS engine (never from daily totals).' })
  @ApiOkResponse({ schema: { example: { driveRemainingSec: 16200, shiftRemainingSec: 20400, cycleRemainingSec: 180000, breakInSec: 7440, onDutySince: '2026-09-12T14:26:00.000Z', cycleLimitSec: 252000, shiftLimitSec: 50400, driveLimitSec: 39600, breakLimitSec: 28800, dutyStatus: 'DRIVING', statusSince: '2026-09-12T18:00:00.000Z', computedAt: '2026-09-12T20:00:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  hos(@Param('id') id: string) {
    return this.roster$.clocks(id);
  }

  @Get(':id')
  @Perm('drivers', 'READ')
  @ApiOperation({ summary: 'Gets one driver profile.' })
  @ApiOkResponse({ schema: { example: { id: 'drv_1', username: 'jsmith', firstName: 'John', lastName: 'Smith', status: 'ACTIVE', cdlNumber: 'W8569238', cdlState: 'OH', homeTerminalTimezone: 'America/New_York', assignedVehicleId: 'veh_1', allowPersonalConveyance: true, allowYardMove: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  get(@Param('id') id: string) {
    return this.drivers.get(id);
  }

  @Post()
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a driver (CDL, home terminal timezone, HOS ruleset, exception flags).' })
  @ApiCreatedResponse({ schema: { example: { id: 'drv_9', username: 'awebb', status: 'ACTIVE', homeTerminalTimezone: 'America/New_York' } } })
  @ApiStandardErrors({
    errors: [
      {
        ...apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.'),
        details: { assignedVehicleId: 'Select a unit.' },
      },
      apiError.fieldConflicts([
        ...DRIVER_FIELD_CONFLICTS,
        { code: ERROR_CODES.VEHICLE_ALREADY_ASSIGNED, field: 'assignedVehicleId', message: DRIVER_CONFLICT_MESSAGES.assignedVehicleId },
        { code: ERROR_CODES.VEHICLE_OUT_OF_SERVICE, field: 'assignedVehicleId', message: 'Vehicle is out of service and cannot be assigned a driver.' },
      ]),
    ],
  })
  create(@Body(zodBody(CreateDriverDto)) dto: CreateDriverDto) {
    return this.drivers.create(dto);
  }

  @Post('import')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'IMPORT' })
  @ApiOperation({ summary: 'Bulk-imports drivers; upserts by `username`.' })
  @ApiOkResponse({ schema: { example: { imported: 3, updated: 1, failed: [] } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.IMPORT_FAILED, 'One or more rows could not be imported.')] })
  import(@Body(zodBody(ImportDriversDto)) dto: ImportDriversDto) {
    return this.drivers.importMany(dto);
  }

  @Patch(':id')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates a driver profile, CDL, or exception flags.' })
  @ApiOkResponse({ schema: { example: { id: 'drv_1', username: 'jsmith', status: 'ACTIVE', allowPersonalConveyance: false } } })
  @ApiStandardErrors({
    errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'), apiError.fieldConflicts(DRIVER_FIELD_CONFLICTS.slice(1))],
  })
  update(@Param('id') id: string, @Body(zodBody(UpdateDriverDto)) dto: UpdateDriverDto) {
    return this.drivers.update(id, dto);
  }

  @Delete(':id')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'DELETE' })
  @ApiOperation({ summary: 'Soft-deletes a driver (status -> TERMINATED, unassigns their unit). Never hard-deletes — see bugs.md B-009.' })
  @ApiOkResponse({ description: 'Soft-deleted — status is TERMINATED, the unit is unassigned.', schema: { example: { id: 'drv_1', status: 'TERMINATED', assignedVehicleId: null } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  remove(@Param('id') id: string) {
    return this.drivers.remove(id);
  }

  @Post(':id/reset-password')
  @HttpCode(202)
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'RESET_PASSWORD' })
  @ApiOperation({ summary: 'B-81 — carrier-side reset of a driver-app password (email or a one-time code for the dispatcher to read out). Always audited.' })
  @ApiOkResponse({ schema: { example: { emailedTo: 'jsmith@example.com' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  resetPassword(@Param('id') id: string) {
    return this.drivers.resetPassword(id);
  }

  @Post(':id/send-verification')
  @HttpCode(202)
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'SEND_EMAIL_VERIFICATION' })
  @ApiOperation({ summary: 'B-29/B-30 — emails a verification token for `Driver.email`.' })
  @ApiOkResponse({ schema: { example: { emailedTo: 'jsmith@example.com' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  sendVerification(@Param('id') id: string) {
    return this.drivers.sendVerification(id);
  }

  @Post(':id/verify-email')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'VERIFY_EMAIL' })
  @ApiOperation({ summary: 'B-31 — confirms the token from `send-verification`; sets `emailVerifiedAt`.' })
  @ApiOkResponse({ schema: { example: { id: 'drv_1', email: 'jsmith@example.com', emailVerifiedAt: '2026-09-24T00:00:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'), { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'Verification token is no longer valid.' }] })
  verifyEmail(@Param('id') id: string, @Body(zodBody(VerifyDriverEmailDto)) dto: VerifyDriverEmailDto) {
    return this.drivers.verifyEmail(id, dto);
  }

  @Get(':id/documents')
  @Perm('drivers', 'READ')
  @ApiOperation({ summary: 'B-94 — lists a driver\'s qualification documents (CDL scan, medical card, ...).' })
  @ApiOkResponse({ schema: { example: [{ id: 'doc_1', type: 'CDL', fileName: 'cdl-front.jpg', expiresAt: '2028-01-01T00:00:00.000Z', uploadedAt: '2026-09-24T00:00:00.000Z', url: 'https://minio/...' }] } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  listDocuments(@Param('id') id: string) {
    return this.drivers.listDocuments(id);
  }

  @Post(':id/documents')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'ADD_DOCUMENT' })
  @ApiOperation({ summary: 'B-94 — records document metadata and returns a presigned PUT for the file upload (TZ §17).' })
  @ApiCreatedResponse({ schema: { example: { id: 'doc_1', type: 'CDL', fileName: 'cdl-front.jpg', expiresAt: null, uploadedAt: '2026-09-24T00:00:00.000Z', url: 'https://minio/...', uploadUrl: 'https://minio/... (PUT)' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.')] })
  createDocument(@Param('id') id: string, @Body(zodBody(CreateDriverDocumentDto)) dto: CreateDriverDocumentDto) {
    return this.drivers.createDocument(id, dto);
  }

  @Delete(':id/documents/:docId')
  @Perm('drivers', 'FULL')
  @Audit({ object: 'Driver', action: 'REMOVE_DOCUMENT' })
  @ApiOperation({ summary: 'B-94 — deletes a driver document (storage object and row).' })
  @ApiOkResponse({ schema: { example: { deleted: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DRIVER_DOCUMENT_NOT_FOUND, 'Driver document not found.')] })
  async removeDocument(@Param('id') id: string, @Param('docId') docId: string) {
    await this.drivers.deleteDocument(id, docId);
    return { deleted: true };
  }
}
