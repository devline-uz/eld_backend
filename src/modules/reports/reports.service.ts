import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Report, ReportSchedule } from '@prisma/client';
import { Queue } from 'bullmq';
import cronParser from 'cron-parser';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { QUEUES } from '../../core/queue/queue.constants';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import {
  ActivityReportParamsDto,
  ActivitySummaryQueryDto,
  CreateReportScheduleDto,
  DvirReportParamsDto,
  FmcsaPackParamsDto,
  GenerateReportDto,
  IftaReportParamsDto,
  IftaSummaryParamsDto,
  ReportListQueryDto,
  UpdateReportScheduleDto,
} from './dto/reports.dto';
import type { ActivitySummaryResult } from './generators/activity-summary.generator';
import { ActivitySummaryGenerator } from './generators/activity-summary.generator';
import type { IftaSummary } from './generators/ifta-report.generator';
import { IftaReportGenerator } from './generators/ifta-report.generator';
import { ReportSchedulesRepository, ReportsRepository } from './reports.repository';

/** TZ §15 — presigned GET for a generated report is valid 7 days (longer than the generic
 * §17 15-minute default: a report link is meant to be shared/reopened over the following
 * week, not consumed once immediately after upload). */
export const REPORT_DOWNLOAD_TTL_SEC = 7 * 24 * 60 * 60;
/** TZ §15/§17 — reports are retained 24 months; `retention.processor` reads `expiresAt`. */
export const REPORT_RETENTION_MONTHS = 24;

export interface ReportJobData {
  reportId: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly schedules: ReportSchedulesRepository,
    private readonly iftaReportGenerator: IftaReportGenerator,
    private readonly activitySummaryGenerator: ActivitySummaryGenerator,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @InjectQueue(QUEUES.REPORT) private readonly queue: Queue<ReportJobData>,
  ) {}

  /** JSON IFTA quarter summary for W-12 (gap B-46) — reads the same persisted
   * `IftaSegment`/`FuelPurchase` totals as the queued CSV, never generated inside a request
   * in the §15 "report" sense since this is a direct read, not a `Report` job. */
  iftaSummary(params: IftaSummaryParamsDto): Promise<IftaSummary> {
    return this.iftaReportGenerator.summary(params);
  }

  /** JSON activity summary for W-13/W-15/dashboard (gap B-46) — see
   * `activity-summary.generator.ts` for why this is a bounded SQL GROUP BY over `DailyLog`/
   * `HosViolation` rather than the per-driver `LogsService.getRange` fan-out it replaces. */
  activitySummary(params: ActivitySummaryQueryDto): Promise<ActivitySummaryResult> {
    return this.activitySummaryGenerator.summary(params);
  }

  /** TZ §15 — "a report is NEVER generated inside a request": enqueue and return 202. */
  async generate(dto: GenerateReportDto, actor: ContextUser): Promise<Report> {
    this.assertFormatAllowed(dto.type, dto.format);
    // `params` reaches the worker verbatim, so it is validated against the schema of its own
    // report type HERE and not only on the synchronous preview routes — otherwise a queued
    // FMCSA pack could ask for a 1000-year window and pin a worker (§22 DoS control).
    const params = assertReportParams(dto.type, dto.params);
    const report = await this.repo.create({
      type: dto.type,
      format: dto.format,
      params: params as object,
      requestedById: actor.id,
    });
    await this.queue.add('report.generate', { reportId: report.id }, { jobId: `report-${report.id}` });
    return report;
  }

  async list(query: ReportListQueryDto) {
    const where = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const { items, total } = await this.repo.list(where, query.page, query.limit);
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) };
  }

  async get(id: string): Promise<Report> {
    const report = await this.repo.findById({ id });
    if (!report) throw AppException.notFound('Report not found.', undefined);
    return report;
  }

  /** Returns a fresh 7-day presigned URL (TZ §15) — never a stored/stale one. */
  async download(id: string): Promise<{ downloadUrl: string; expiresAt: Date; fileName: string }> {
    const report = await this.get(id);
    if (report.status !== 'READY' || !report.fileKey) {
      throw new AppException(ERROR_CODES.REPORT_NOT_READY, 'Report is not ready for download yet.', 409);
    }
    const downloadUrl = await this.storage.presignGet(report.fileKey, REPORT_DOWNLOAD_TTL_SEC);
    const expiresAt = new Date(Date.now() + REPORT_DOWNLOAD_TTL_SEC * 1000);
    const fileName = report.fileKey.split('/').pop() ?? report.fileKey;
    return { downloadUrl, expiresAt, fileName };
  }

  // ---------------------------------------------------------------------------------------
  // Schedules — TZ §15 "Report scheduler (BullMQ)": cron-like definitions persisted in the DB
  // ---------------------------------------------------------------------------------------

  async createSchedule(dto: CreateReportScheduleDto, actor: ContextUser): Promise<ReportSchedule> {
    this.assertFormatAllowed(dto.reportType, dto.format);
    const nextRunAt = this.computeNextRun(dto.cron, dto.timezone);
    return this.schedules.create({
      reportType: dto.reportType,
      format: dto.format,
      params: dto.params as object,
      cron: dto.cron,
      timezone: dto.timezone,
      recipients: dto.recipients,
      enabled: dto.enabled,
      nextRunAt,
      createdById: actor.id,
    });
  }

  async listSchedules(): Promise<ReportSchedule[]> {
    return this.schedules.listAll();
  }

  async updateSchedule(id: string, dto: UpdateReportScheduleDto): Promise<ReportSchedule> {
    const existing = await this.schedules.findById({ id });
    if (!existing) throw AppException.notFound('Report schedule not found.');
    if (dto.reportType && dto.format) this.assertFormatAllowed(dto.reportType, dto.format);
    const cron = dto.cron ?? existing.cron;
    const timezone = dto.timezone ?? existing.timezone;
    const nextRunAt = dto.cron || dto.timezone ? this.computeNextRun(cron, timezone) : undefined;
    return this.schedules.update(
      { id },
      {
        ...(dto.reportType ? { reportType: dto.reportType } : {}),
        ...(dto.format ? { format: dto.format } : {}),
        ...(dto.params ? { params: dto.params as object } : {}),
        ...(dto.cron ? { cron: dto.cron } : {}),
        ...(dto.timezone ? { timezone: dto.timezone } : {}),
        ...(dto.recipients ? { recipients: dto.recipients } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
      },
    );
  }

  computeNextRun(cron: string, timezone: string, from: Date = new Date()): Date {
    try {
      const interval = cronParser.parseExpression(cron, { currentDate: from, tz: timezone });
      return interval.next().toDate();
    } catch {
      throw new AppException(ERROR_CODES.INVALID_CRON_EXPRESSION, `"${cron}" is not a valid 5-field cron expression.`, 422);
    }
  }

  private assertFormatAllowed(type: string, format: string): void {
    if (type === 'FMCSA_PACK' && format !== 'PDF') {
      throw AppException.unprocessable(
        ERROR_CODES.VALIDATION_FAILED,
        'FMCSA_PACK is generated as PDF only (the cover sheet); Appendix A output files are CSV by definition and attached per driver.',
      );
    }
    if (type !== 'FMCSA_PACK' && format !== 'CSV') {
      throw AppException.unprocessable(
        ERROR_CODES.VALIDATION_FAILED,
        `${type} reports are generated as CSV in this version (streaming export, TZ §15).`,
      );
    }
  }
}

const REPORT_PARAM_SCHEMAS = {
  IFTA: IftaReportParamsDto,
  ACTIVITY: ActivityReportParamsDto,
  DVIR: DvirReportParamsDto,
  FMCSA_PACK: FmcsaPackParamsDto,
} as const;

/** Parses `params` with the schema of the requested report type (range caps included). */
export function assertReportParams(type: keyof typeof REPORT_PARAM_SCHEMAS, params: unknown): unknown {
  const parsed = REPORT_PARAM_SCHEMAS[type].safeParse(params);
  if (!parsed.success) {
    throw AppException.unprocessable(ERROR_CODES.VALIDATION_FAILED, `Invalid ${type} report params.`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}
