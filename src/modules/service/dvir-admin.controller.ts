import { Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Audit } from '../../common/decorators/audit.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { DvirAdminService } from './dvir-admin.service';
import { DvirComplianceQueryDto, DvirListQueryDto, MechanicSignOffDto, NextDriverReviewDto } from './dto/service.dto';

/** TZ §5.10 — "DVIR & Maintenance" screen, read side of the driver-submitted DVIRs plus the
 * §396.13 mechanic sign-off and next-driver-review steps. */
@FigmaScreen('web/dvir-maintenance')
@ApiTags('dvir')
@ApiBearerAuth()
@Controller('dvir')
export class DvirAdminController {
  constructor(private readonly dvir: DvirAdminService) {}

  @Get()
  @Perm('dvir', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'driverId', required: false })
  @ApiQuery({ name: 'repairStatus', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'B-47 — YYYY-MM-DD, inclusive.' })
  @ApiQuery({ name: 'to', required: false, description: 'B-47 — YYYY-MM-DD, inclusive.' })
  @ApiOperation({ summary: 'Lists submitted DVIRs (TZ §5.10 "DVIR & Maintenance" screen).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'dvir_1', driverId: 'drv_1', vehicleId: 'veh_1', type: 'PRE_TRIP', vehicleCondition: 'DEFECTS_FOUND', repairStatus: 'PENDING' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(DvirListQueryDto)) query: DvirListQueryDto) {
    return this.dvir.list(query);
  }

  @Get('compliance')
  @Perm('dvir', 'READ')
  @ApiQuery({ name: 'from', required: true, description: 'YYYY-MM-DD, inclusive.' })
  @ApiQuery({ name: 'to', required: true, description: 'YYYY-MM-DD, inclusive.' })
  @ApiOperation({ summary: 'B-47 — expected vs submitted PRE_TRIP DVIRs across the active fleet for a date range (W-14 compliance chip / missing rows). Declared before `:id` so it is never swallowed.' })
  @ApiOkResponse({ schema: { example: { expected: 60, submitted: 57, compliancePct: 95, missing: [{ vehicleId: 'veh_1', unitNumber: '110', date: '2026-09-20' }] } } })
  @ApiStandardErrors()
  compliance(@Query(zodBody(DvirComplianceQueryDto)) query: DvirComplianceQueryDto) {
    return this.dvir.compliance(query);
  }

  @Get(':id')
  @Perm('dvir', 'READ')
  @ApiOperation({ summary: 'Gets one DVIR with its defects and photos.' })
  @ApiOkResponse({ schema: { example: { id: 'dvir_1', vehicleId: 'veh_1', defects: [{ id: 'def_1', part: 'TRUCK', severity: 'CRITICAL', status: 'OPEN' }] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.')] })
  get(@Param('id') id: string) {
    return this.dvir.get(id);
  }

  @Get(':id/pdf')
  @Perm('dvir', 'READ')
  @ApiOperation({ summary: 'B-75 — renders one DVIR to a §396.11 PDF: inspection record, defects and both signatures. Declared before any other :id sub-route so it is never swallowed.' })
  @ApiOkResponse({
    description: 'Raw application/pdf bytes (not wrapped in the success envelope).',
    content: { 'application/pdf': { schema: { type: 'string', format: 'binary', example: '%PDF-1.7 ...' } } },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.')] })
  async getPdf(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const pdf = await this.dvir.getPdf(id);
    // B-1NN: NestJS's Express adapter JSON-serializes any object-typed return value
    // (`isObject(body) ? response.json(body) : response.send(body)`), and a `Buffer` IS
    // an object — `@Res({ passthrough: true })` + `return pdf` silently sent
    // `{"type":"Buffer","data":[...]}` instead of raw PDF bytes, even with the
    // Content-Type header set correctly. Writing the response directly (no passthrough,
    // no return value for Nest to re-serialize) is the only way to send real binary.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="dvir-${id}.pdf"`);
    res.send(pdf);
  }

  @Post(':id/mechanic-signoff')
  @Perm('dvir', 'FULL')
  @Audit({ object: 'Dvir', action: 'MECHANIC_SIGNOFF' })
  @ApiOperation({ summary: 'Records the mechanic review of a DVIR\'s defects (TZ §396.13).' })
  @ApiOkResponse({ schema: { example: { id: 'dvir_1', mechanicName: 'J. Alvarez', repairStatus: 'REPAIRED', mechanicSignedAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.')] })
  mechanicSignOff(@Param('id') id: string, @Body(zodBody(MechanicSignOffDto)) dto: MechanicSignOffDto) {
    return this.dvir.mechanicSignOff(id, dto);
  }

  @Patch(':id/next-driver-review')
  @Perm('dvir', 'FULL')
  @Audit({ object: 'Dvir', action: 'NEXT_DRIVER_REVIEW' })
  @ApiOperation({ summary: 'Marks that the next driver reviewed the prior DVIR\'s mechanic sign-off (TZ §396.13).' })
  @ApiOkResponse({ schema: { example: { id: 'dvir_1', nextDriverReviewedAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.')] })
  nextDriverReview(@Param('id') id: string, @Body(zodBody(NextDriverReviewDto)) dto: NextDriverReviewDto) {
    return this.dvir.nextDriverReview(id, dto);
  }
}
