import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import { MaintenanceSubmitDto } from './dto/mobile-maintenance.dto';
import { MaintenanceDetailResponse, MaintenanceItemResponse } from './dto/mobile.responses';
import { MobileMaintenanceService } from './mobile-maintenance.service';

/**
 * M-38..M-42 (mobile wave 4) — the driver's maintenance tasks for the unit they currently have
 * selected, and the invoice submission that back office approves/rejects (`PATCH
 * /maintenance-schedules/:id`). Driver token only (`DriverGuard`), not RBAC.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/maintenance')
export class MobileMaintenanceController {
  constructor(private readonly service: MobileMaintenanceService) {}

  @Get()
  @ApiOperation({
    summary: 'M-38 — maintenance tasks of the driver\'s selected unit (actionable first, most overdue first).',
    description:
      '`remainingMi` is relative to the unit odometer; a negative value means overdue by that many miles, `null` = date-only interval. ' +
      '`at` = completion time (COMPLETED), else last submission, else due date. `[]` when no unit is selected.',
  })
  @ApiEnvelopeResponse(MaintenanceItemResponse, {
    isArray: true,
    example: [{ id: '3f2c0a7e-0000-4000-8000-000000000001', scheduleType: 'OIL_CHANGE', scheduleName: 'Engine oil & filter', frequencyMi: 25000, remainingMi: 1200, status: 'OPEN', at: '2026-11-01T00:00:00.000Z' }],
  })
  @ApiStandardErrors()
  list(@CurrentUser('id') driverId: string) {
    return this.service.list(driverId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'M-39/M-41 — one maintenance task with the submitted invoice (if any) and the reviewer\'s note.' })
  @ApiEnvelopeResponse(MaintenanceDetailResponse, {
    example: {
      id: '3f2c0a7e-0000-4000-8000-000000000001', scheduleType: 'OIL_CHANGE', scheduleName: 'Engine oil & filter', frequencyMi: 25000, remainingMi: 1200, status: 'REJECTED', at: '2026-10-08T12:00:00.000Z',
      invoiceNumber: 'INV-2291', vendorName: 'Pilot Truck Care', cost: 412.5, notes: 'Changed filters too', invoiceAttachment: { id: '9a1d...', fileName: 'invoice-INV-2291.pdf', mimeType: 'application/pdf' },
      submittedAt: '2026-10-08T12:00:00.000Z', reviewNote: 'Amount does not match the PDF.',
    },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.MAINTENANCE_SCHEDULE_NOT_FOUND, 'Task not found, or it belongs to a unit other than the selected one.')] })
  get(@Param('id') id: string, @CurrentUser('id') driverId: string) {
    return this.service.get(driverId, id);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({
    summary: 'M-40 — submits the service invoice of a maintenance task for back-office review.',
    description:
      'Allowed while the task is OPEN or REJECTED (resubmit). `invoiceAttachmentId` = `signatureImageId` of `POST /mobile/signature {purpose:"INVOICE", mimeType:"application/pdf"}`. ' +
      'Idempotent on `clientId`: a replay returns the first answer; a `clientId` spent on another operation -> 409. The task stays OPEN with `submittedAt` set until back office approves (COMPLETED) or rejects (REJECTED + `reviewNote`).',
  })
  @ApiBody({ schema: { example: { invoiceNumber: 'INV-2291', vendorName: 'Pilot Truck Care', cost: 412.5, notes: 'Changed filters too', invoiceAttachmentId: '9a1d2b3c-0000-4000-8000-000000000009', clientId: '7d1c2a40-0000-4000-8000-000000000001' } } })
  @ApiEnvelopeResponse(MaintenanceDetailResponse, {
    example: {
      id: '3f2c0a7e-0000-4000-8000-000000000001', scheduleType: 'OIL_CHANGE', scheduleName: 'Engine oil & filter', frequencyMi: 25000, remainingMi: 1200, status: 'OPEN', at: '2026-10-08T12:00:00.000Z',
      invoiceNumber: 'INV-2291', vendorName: 'Pilot Truck Care', cost: 412.5, notes: 'Changed filters too', invoiceAttachment: { id: '9a1d2b3c-0000-4000-8000-000000000009', fileName: 'invoice-INV-2291.pdf', mimeType: 'application/pdf' },
      submittedAt: '2026-10-08T12:00:00.000Z', reviewNote: null,
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.MAINTENANCE_SCHEDULE_NOT_FOUND, 'Task not found, or it belongs to a unit other than the selected one.'),
      apiError.conflict(ERROR_CODES.CONFLICT, 'The task is COMPLETED/CANCELLED, or clientId was already used by another operation.'),
      apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'invoiceAttachmentId is not an INVOICE upload of this driver.'),
    ],
  })
  submit(@Param('id') id: string, @Body(zodBody(MaintenanceSubmitDto)) dto: MaintenanceSubmitDto, @CurrentUser('id') driverId: string) {
    return this.service.submit(driverId, id, dto);
  }
}
