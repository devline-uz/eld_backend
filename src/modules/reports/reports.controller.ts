import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import {
  ActivityReportQueryDto,
  ActivitySummaryQueryDto,
  CreateReportScheduleDto,
  DvirReportQueryDto,
  FmcsaPackParamsDto,
  GenerateReportDto,
  IftaReportQueryDto,
  IftaSummaryParamsDto,
  ReportListQueryDto,
  UpdateReportScheduleDto,
} from './dto/reports.dto';
import { listJurisdictions } from './lib/jurisdiction';
import { ReportsService } from './reports.service';

/**
 * TZ §11.6/§15 — reports are always generated asynchronously. `POST /reports/generate`
 * returns `202 { reportId, status: "QUEUED" }`; the client polls `GET /reports/:id` or
 * waits for the `report.ready` WebSocket event (`report.processor.ts`).
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('generate')
  @Perm('reports', 'FULL')
  @Audit({ object: 'Report', action: 'CREATE' })
  @ApiOperation({ summary: 'Queues a report job. Never generates synchronously — poll GET /reports/:id or listen for report.ready.' })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('reports = FULL is required to generate a report (§6.4).'),
      apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Requested format is not supported for this report type.'),
    ],
  })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Queued.', schema: { example: { reportId: 'rpt_1', status: 'QUEUED' } } })
  async generate(@Body(zodBody(GenerateReportDto)) dto: GenerateReportDto, @CurrentUser() actor: ContextUser) {
    const report = await this.reports.generate(dto, actor);
    return { reportId: report.id, status: report.status };
  }

  @Get()
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Lists report jobs (own carrier), newest first.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'rpt_1', type: 'IFTA', status: 'READY', requestedAt: '2026-09-11T06:00:00.000Z' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(ReportListQueryDto)) query: ReportListQueryDto) {
    return this.reports.list(query);
  }

  @Get('schedules')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Lists report schedules (TZ §15 report scheduler — cron definitions persisted in the DB).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'sch_1', reportType: 'ACTIVITY', cron: '0 6 * * 1', enabled: true, nextRunAt: '2026-09-14T06:00:00.000Z' }] } } })
  @ApiStandardErrors()
  async listSchedules() {
    return { items: await this.reports.listSchedules() };
  }

  @Post('schedules')
  @Perm('reports', 'FULL')
  @Audit({ object: 'ReportSchedule', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a report schedule. `nextRunAt` is computed from `cron`/`timezone` and the scheduler picks it up without a manual trigger.' })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('reports = FULL is required (§6.4).'),
      apiError.unprocessable(ERROR_CODES.INVALID_CRON_EXPRESSION, '"not a cron" is not a valid 5-field cron expression.'),
    ],
  })
  @ApiOkResponse({ schema: { example: { id: 'sch_1', reportType: 'ACTIVITY', cron: '0 6 * * 1', nextRunAt: '2026-09-14T06:00:00.000Z' } } })
  createSchedule(@Body(zodBody(CreateReportScheduleDto)) dto: CreateReportScheduleDto, @CurrentUser() actor: ContextUser) {
    return this.reports.createSchedule(dto, actor);
  }

  @Patch('schedules/:id')
  @Perm('reports', 'FULL')
  @Audit({ object: 'ReportSchedule', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates a report schedule (e.g. toggle `enabled`, change `cron`).' })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.REPORT_SCHEDULE_NOT_FOUND, 'Report schedule not found.')] })
  @ApiOkResponse({ schema: { example: { id: 'sch_1', enabled: false } } })
  updateSchedule(@Param('id') id: string, @Body(zodBody(UpdateReportScheduleDto)) dto: UpdateReportScheduleDto) {
    return this.reports.updateSchedule(id, dto);
  }

  @Delete('schedules/:id')
  @Perm('reports', 'FULL')
  @Audit({ object: 'ReportSchedule', action: 'DELETE' })
  @HttpCode(204)
  @ApiOperation({ summary: 'Deletes a report schedule. Reports it already generated are kept.' })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('reports = FULL is required (§6.4).'),
      apiError.notFound(ERROR_CODES.REPORT_SCHEDULE_NOT_FOUND, 'Report schedule not found.'),
    ],
  })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  async deleteSchedule(@Param('id') id: string): Promise<void> {
    await this.reports.deleteSchedule(id);
  }

  @Get('ifta')
  @FigmaScreen('web/reports-ifta')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Shortcut: queues an IFTA report for a quarter (TZ §11.6 `/reports/ifta?quarter=`). `?format=PDF` (B-96) queues the PDF instead of the CSV — still READ, no FULL required.' })
  @ApiQuery({ name: 'format', required: false, enum: ['CSV', 'PDF'] })
  @ApiQuery({ name: 'quarter', required: true, example: '2026-Q3' })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'vehicleGroupId', required: false, description: 'Only units in this vehicle group (`GET /vehicle-groups`).' })
  @ApiQuery({ name: 'jurisdiction', required: false, description: 'Two-letter code from `GET /reports/ifta/jurisdictions`.' })
  @ApiStandardErrors({ errors: [apiError.validation('quarter must look like 2026-Q3.')] })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Queued.', schema: { example: { reportId: 'rpt_2', status: 'QUEUED' } } })
  async ifta(@Query(zodBody(IftaReportQueryDto)) params: IftaReportQueryDto, @CurrentUser() actor: ContextUser) {
    const { format, ...reportParams } = params;
    const report = await this.reports.generate({ type: 'IFTA', format, params: reportParams }, actor);
    return { reportId: report.id, status: report.status };
  }

  @Get('ifta/jurisdictions')
  @FigmaScreen('web/reports-ifta')
  @Perm('reports', 'READ')
  @ApiOperation({
    summary:
      'IFTA jurisdictions for the W-12 `Jurisdiction` menu — every US state / Canadian province code an IftaSegment can carry (US first, then Canada, each by name). Declared before GET /reports/:id.',
  })
  @ApiOkResponse({ schema: { example: { items: [{ code: 'AL', name: 'Alabama', country: 'US' }, { code: 'ON', name: 'Ontario', country: 'CA' }] } } })
  @ApiStandardErrors()
  iftaJurisdictions() {
    return { items: listJurisdictions() };
  }

  @Get('ifta/summary')
  @FigmaScreen('web/reports-ifta')
  @Perm('reports', 'READ')
  @ApiQuery({ name: 'quarter', required: true, example: '2026-Q3' })
  @ApiQuery({ name: 'vehicleId', required: false })
  @ApiQuery({ name: 'vehicleGroupId', required: false, description: 'Only units in this vehicle group (`GET /vehicle-groups`). 404 VEHICLE_GROUP_NOT_FOUND if unknown.' })
  @ApiQuery({
    name: 'jurisdiction',
    required: false,
    description: 'Two-letter code from `GET /reports/ifta/jurisdictions`. Narrows rows, miles, gallons and receipts to it; fleet MPG stays fleet-wide.',
  })
  @ApiOperation({
    summary:
      'JSON IFTA quarter summary for the W-12 screen (gap B-46) — jurisdiction totals, fleet MPG and the vs-prev-quarter chip, read directly from the same IftaSegment/FuelPurchase totals the CSV export uses. Declared before GET /reports/:id so it is never swallowed by the id param route.',
  })
  @ApiStandardErrors({
    errors: [
      apiError.validation('quarter must look like 2026-Q3.'),
      apiError.notFound(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.'),
    ],
  })
  @ApiOkResponse({
    schema: {
      example: {
        quarter: '2026-Q3',
        unitCount: 12,
        kpis: { totalMiles: 48213, taxableMiles: 48213, taxablePct: 100, fuelGal: 6021.4, receiptCount: 312, fleetMpg: 8.01, fleetMpgPrev: 7.86 },
        rows: [{ jurisdiction: 'CA', totalMiles: 9120, taxableMiles: 9120, fuelGal: 1138.9, mpg: 8.01, taxDueUsd: null }],
        totals: { totalMiles: 48213, taxableMiles: 48213, fuelGal: 6021.4, mpg: 8.01, taxDueUsd: null },
      },
    },
  })
  iftaSummary(@Query(zodBody(IftaSummaryParamsDto)) params: IftaSummaryParamsDto) {
    return this.reports.iftaSummary(params);
  }

  @Get('activity')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Shortcut: queues an activity report for a date range. `?format=PDF` (B-96) queues the PDF instead of the CSV — still READ, no FULL required.' })
  @ApiQuery({ name: 'format', required: false, enum: ['CSV', 'PDF'] })
  @ApiStandardErrors({ errors: [apiError.validation('from/to must be YYYY-MM-DD.')] })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Queued.', schema: { example: { reportId: 'rpt_3', status: 'QUEUED' } } })
  async activity(@Query(zodBody(ActivityReportQueryDto)) params: ActivityReportQueryDto, @CurrentUser() actor: ContextUser) {
    const { format, ...reportParams } = params;
    const report = await this.reports.generate({ type: 'ACTIVITY', format, params: reportParams }, actor);
    return { reportId: report.id, status: report.status };
  }

  @Get('activity/summary')
  @Perm('reports', 'READ')
  @ApiQuery({ name: 'from', required: true, example: '2026-09-01' })
  @ApiQuery({ name: 'to', required: true, example: '2026-09-14' })
  @ApiQuery({ name: 'vehicleGroupId', required: false, description: 'Only drivers whose currently assigned unit is in this vehicle group.' })
  @ApiQuery({
    name: 'groupBy',
    required: false,
    enum: ['driver', 'vehicleGroup'],
    description:
      '`driver` (default): one row per driver. `vehicleGroup`: one row per group of the driver\'s currently assigned unit — `{ groupId, name, drivers, days, offSec, sbSec, drivingSec, onSec, distanceMi, violations, certifiedDays }`, `groupId: null` / `name: "Ungrouped"` for drivers with no unit or an ungrouped unit.',
  })
  @ApiOperation({
    summary:
      'JSON per-driver activity aggregate for W-13/W-15/dashboard (gap B-46) — the web previously fanned out one GET /logs/:driverId/range call per driver (308 calls, 3s→15s in QA). Computed in SQL from DailyLog + HosViolation, never per-driver RODS rebuilds, and never loads EldEvent rows. Declared before GET /reports/:id so it is never swallowed by the id param route.',
  })
  @ApiStandardErrors({ errors: [apiError.validation('from/to must be YYYY-MM-DD and the range must not exceed 366 days.')] })
  @ApiOkResponse({
    schema: {
      example: {
        kpis: { drivingSec: 412200, drivingDeltaPct: 4.2, onDutySec: 88200, distanceMi: 18412, violations: 3, violationsDelta: -1 },
        items: [
          {
            driverId: 'drv_1',
            name: 'Doe, John',
            days: 8,
            offSec: 172800,
            sbSec: 28800,
            drivingSec: 39600,
            onSec: 7200,
            distanceMi: 512,
            violations: 0,
            certifiedDays: 8,
          },
        ],
        page: 1,
        limit: 25,
        total: 264,
        totalPages: 11,
      },
    },
  })
  activitySummary(@Query(zodBody(ActivitySummaryQueryDto)) params: ActivitySummaryQueryDto) {
    return this.reports.activitySummary(params);
  }

  @Get('dvir')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Shortcut: queues a DVIR report for a date range. `?format=PDF` (B-96) queues the PDF instead of the CSV — still READ, no FULL required.' })
  @ApiQuery({ name: 'format', required: false, enum: ['CSV', 'PDF'] })
  @ApiStandardErrors({ errors: [apiError.validation('from/to must be YYYY-MM-DD.')] })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Queued.', schema: { example: { reportId: 'rpt_4', status: 'QUEUED' } } })
  async dvir(@Query(zodBody(DvirReportQueryDto)) params: DvirReportQueryDto, @CurrentUser() actor: ContextUser) {
    const { format, ...reportParams } = params;
    const report = await this.reports.generate({ type: 'DVIR', format, params: reportParams }, actor);
    return { reportId: report.id, status: report.status };
  }

  @Get('fmcsa-pack')
  @FigmaScreen('web/reports-fmcsa-audit-pack')
  @Perm('reportsTransfer', 'READ')
  @ApiOperation({ summary: 'Shortcut: queues an FMCSA compliance package (Appendix A output files per driver + PDF cover) for a date range.' })
  @ApiStandardErrors({ errors: [apiError.validation('from/to must be YYYY-MM-DD.')] })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Queued.', schema: { example: { reportId: 'rpt_5', status: 'QUEUED' } } })
  async fmcsaPack(@Query(zodBody(FmcsaPackParamsDto)) params: FmcsaPackParamsDto, @CurrentUser() actor: ContextUser) {
    const report = await this.reports.generate({ type: 'FMCSA_PACK', format: 'PDF', params }, actor);
    return { reportId: report.id, status: report.status };
  }

  @Get(':id')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Report job status and, once READY, a fresh 7-day presigned download URL (TZ §15/§17).' })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.REPORT_NOT_FOUND, 'Report not found.')] })
  @ApiOkResponse({ schema: { example: { id: 'rpt_1', type: 'IFTA', status: 'READY', rowCount: 12, completedAt: '2026-09-11T06:01:00.000Z' } } })
  get(@Param('id') id: string) {
    return this.reports.get(id);
  }

  @Get(':id/download')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Fresh presigned GET URL for a READY report (7-day TTL, TZ §15). 409 if not ready yet.' })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.REPORT_NOT_FOUND, 'Report not found.'),
      { status: 409, code: ERROR_CODES.REPORT_NOT_READY, message: 'Report is not ready for download yet.' },
    ],
  })
  @ApiOkResponse({ schema: { example: { downloadUrl: 'https://minio.local/reports/rpt_1.csv?X-Amz-Signature=...', expiresAt: '2026-09-18T06:01:00.000Z', fileName: 'rpt_1.csv' } } })
  download(@Param('id') id: string) {
    return this.reports.download(id);
  }

  @Get(':id/file')
  @Perm('reports', 'READ')
  @ApiOperation({
    summary:
      'Downloads a READY report file through the API (attachment, `text/csv` or `application/pdf`). The web panel uses this instead of the presigned URL, which points at an object-storage host the browser may not reach. 409 if not ready yet.',
  })
  @ApiOkResponse({
    description: 'The report file itself. Not wrapped in the success envelope.',
    content: {
      'text/csv': { schema: { type: 'string' }, example: 'Jurisdiction,Total miles,Taxable miles\nOH,42,42\n' },
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.REPORT_NOT_FOUND, 'Report not found.'),
      { status: 409, code: ERROR_CODES.REPORT_NOT_READY, message: 'Report is not ready for download yet.' },
    ],
  })
  async file(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<Buffer> {
    const { fileName, contentType, body } = await this.reports.file(id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    // Returning a Buffer opts out of the success envelope (TransformInterceptor).
    return body;
  }
}
