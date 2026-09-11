import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import {
  ActivityReportParamsDto,
  CreateReportScheduleDto,
  DvirReportParamsDto,
  FmcsaPackParamsDto,
  GenerateReportDto,
  IftaReportParamsDto,
  ReportListQueryDto,
  UpdateReportScheduleDto,
} from './dto/reports.dto';
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

  @Get('ifta')
  @FigmaScreen('web/reports-ifta')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Shortcut: queues an IFTA report for a quarter (TZ §11.6 `/reports/ifta?quarter=`).' })
  @ApiStandardErrors({ errors: [apiError.validation('quarter must look like 2026-Q3.')] })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Queued.', schema: { example: { reportId: 'rpt_2', status: 'QUEUED' } } })
  async ifta(@Query(zodBody(IftaReportParamsDto)) params: IftaReportParamsDto, @CurrentUser() actor: ContextUser) {
    const report = await this.reports.generate({ type: 'IFTA', format: 'CSV', params }, actor);
    return { reportId: report.id, status: report.status };
  }

  @Get('activity')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Shortcut: queues an activity report for a date range.' })
  @ApiStandardErrors({ errors: [apiError.validation('from/to must be YYYY-MM-DD.')] })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Queued.', schema: { example: { reportId: 'rpt_3', status: 'QUEUED' } } })
  async activity(@Query(zodBody(ActivityReportParamsDto)) params: ActivityReportParamsDto, @CurrentUser() actor: ContextUser) {
    const report = await this.reports.generate({ type: 'ACTIVITY', format: 'CSV', params }, actor);
    return { reportId: report.id, status: report.status };
  }

  @Get('dvir')
  @Perm('reports', 'READ')
  @ApiOperation({ summary: 'Shortcut: queues a DVIR report for a date range.' })
  @ApiStandardErrors({ errors: [apiError.validation('from/to must be YYYY-MM-DD.')] })
  @HttpCode(202)
  @ApiResponse({ status: 202, description: 'Queued.', schema: { example: { reportId: 'rpt_4', status: 'QUEUED' } } })
  async dvir(@Query(zodBody(DvirReportParamsDto)) params: DvirReportParamsDto, @CurrentUser() actor: ContextUser) {
    const report = await this.reports.generate({ type: 'DVIR', format: 'CSV', params }, actor);
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
}
