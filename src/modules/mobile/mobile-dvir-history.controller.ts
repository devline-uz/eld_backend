import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import { DvirHistoryQueryDto } from './dto/mobile-fleet-ops.dto';
import { DvirDetailResponse, DvirSummaryResponse } from './dto/mobile.responses';
import { MobileDvirHistoryService } from './mobile-dvir-history.service';

/**
 * mobile/tz.md §21.1 MB-10, screens M-10/M-11/P-07 — the driver's own DVIR history.
 * Deliberately its own controller (not `MobileDvirController`) per `mobile/decisions.md`
 * MD-001: that file is being edited concurrently for the MB-6 photo-linking bug fix.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/dvirs')
export class MobileDvirHistoryController {
  constructor(private readonly service: MobileDvirHistoryService) {}

  @Get()
  @ApiOperation({ summary: 'M-10 — own DVIR history: defect count, condition and repair-status summary per submission.' })
  @ApiEnvelopeResponse(DvirSummaryResponse, {
    isArray: true,
    example: [{ id: 'dvir_1', vehicleId: 'veh_1', type: 'PRE_TRIP', submittedAt: '2026-09-10T12:00:00.000Z', vehicleCondition: 'DEFECTS_FOUND', defectCount: 1, repairStatus: 'PENDING', trailerNumber: 'X53-1188', odometerMi: 84213 }],
  })
  @ApiStandardErrors()
  list(@Query(zodBody(DvirHistoryQueryDto)) query: DvirHistoryQueryDto, @CurrentUser('id') driverId: string) {
    return this.service.list(driverId, query.days);
  }

  @Get(':id')
  @ApiOperation({ summary: 'M-11/P-07 — full DVIR detail: defects, photos, driver + mechanic signatures.' })
  @ApiEnvelopeResponse(DvirDetailResponse, {
    example: {
      id: 'dvir_1', driverId: 'drv_1', vehicleId: 'veh_1', trailerId: null, type: 'PRE_TRIP', submittedAt: '2026-09-10T12:00:00.000Z', odometerMi: 84213,
      location: { lat: 39.96, lon: -82.99, name: '2mi ESE OH Columbus' }, trailerNumber: 'X53-1188', vehicleCondition: 'DEFECTS_FOUND', notes: null, repairStatus: 'PENDING',
      driverSignature: { key: 'signatures/drv_1/sig_9c2a.png', url: 'https://...', hash: 'a1b2...' },
      mechanicSignature: null,
      nextDriverReviewedAt: null,
      defects: [{ id: 'def_1', part: 'TRUCK', category: 'BRAKES_SERVICE', severity: 'MAJOR', description: 'Air leak at the rear axle', status: 'OPEN', outOfService: false, resolvedAt: null, resolutionNote: null, photos: [{ id: 'att_1', url: 'https://...', mimeType: 'image/jpeg', sizeBytes: 120344 }] }],
      photos: [],
    },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.')] })
  get(@Param('id') id: string, @CurrentUser('id') driverId: string) {
    return this.service.get(id, driverId);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'M-11 — per-DVIR PDF export. Not implemented yet: no single-DVIR PDF generator exists (see MobileDvirHistoryService) — every call answers 501 today; the 200 below documents the contract once a generator lands.' })
  @ApiResponse({
    status: 200,
    description: 'Future state once a single-DVIR PDF generator exists — every call answers 501 today (see below).',
    content: { 'application/pdf': { schema: { type: 'string', format: 'binary', example: '%PDF-1.4 ...' } } },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.'),
      { status: 501, code: ERROR_CODES.NOT_IMPLEMENTED, message: 'A single-DVIR PDF export is not implemented yet.' },
    ],
  })
  pdf(@Param('id') id: string, @CurrentUser('id') driverId: string) {
    return this.service.pdf(id, driverId);
  }
}
