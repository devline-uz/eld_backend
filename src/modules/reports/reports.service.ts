import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Report, ReportSchedule } from '@prisma/client';
import { Queue } from 'bullmq';
import cronParser from 'cron-parser';
import { PERMISSION_LEVEL_RANK } from '../../common/decorators/permission.types';
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
  IdleFuelReportParamsDto,
  IftaReportParamsDto,
  IftaSummaryParamsDto,
  ReportListQueryDto,
  REPORT_TYPE_FORMATS,
  REPORT_WINDOWS,
  RodsReportParamsDto,
  UpdateReportScheduleDto,
} from './dto/reports.dto';
import { resolveScheduleParams } from './lib/report-window';
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
  /** Set by the report scheduler: once READY, the file is emailed to this schedule's recipients. */
  scheduleId?: string;
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
    // CODE-016 — the FMCSA pack is a §6.4 `reportsTransfer` artefact whichever route queues it.
    if (dto.type === 'FMCSA_PACK') assertMayAccessFmcsaPack(actor);
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

  async list(query: ReportListQueryDto, actor?: ContextUser) {
    // CODE-016 — without reportsTransfer READ the FMCSA packs are not listed at all.
    const hideFmcsa = actor !== undefined && !mayAccessFmcsaPack(actor);
    if (hideFmcsa && query.type === 'FMCSA_PACK') {
      return { items: [], page: query.page, limit: query.limit, total: 0, totalPages: 0 };
    }
    const where = {
      ...(query.type ? { type: query.type } : hideFmcsa ? { type: { not: 'FMCSA_PACK' as const } } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const { items, total } = await this.repo.list(where, query.page, query.limit);
    return {
      items: items.map((item) => withRequestedBy(item)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  /** B-46 — `requestedBy: { id, name }` on read. */
  async get(id: string, actor?: ContextUser) {
    const report = await this.repo.findByIdWithRequestedBy(id);
    if (!report) throw AppException.notFound('Report not found.', undefined);
    if (report.type === 'FMCSA_PACK' && actor) assertMayAccessFmcsaPack(actor);
    return withRequestedBy(report);
  }

  /** Returns a fresh 7-day presigned URL (TZ §15) — never a stored/stale one. */
  async download(id: string, actor?: ContextUser): Promise<{ downloadUrl: string; expiresAt: Date; fileName: string }> {
    const report = await this.get(id, actor);
    if (report.status !== 'READY' || !report.fileKey) {
      throw new AppException(ERROR_CODES.REPORT_NOT_READY, 'Report is not ready for download yet.', 409);
    }
    const downloadUrl = await this.storage.presignGet(report.fileKey, REPORT_DOWNLOAD_TTL_SEC);
    const expiresAt = new Date(Date.now() + REPORT_DOWNLOAD_TTL_SEC * 1000);
    const fileName = report.fileKey.split('/').pop() ?? report.fileKey;
    return { downloadUrl, expiresAt, fileName };
  }

  /** The READY report's bytes, streamed through the API for the web panel. A presigned URL
   * points at `S3_ENDPOINT` — on the servers that is MinIO on 127.0.0.1, which a browser cannot
   * reach — so the panel downloads through this authenticated route instead. */
  async file(id: string, actor?: ContextUser): Promise<{ fileName: string; contentType: string; body: Buffer }> {
    const report = await this.get(id, actor);
    if (report.status !== 'READY' || !report.fileKey) {
      throw new AppException(ERROR_CODES.REPORT_NOT_READY, 'Report is not ready for download yet.', 409);
    }
    const body = await this.storage.get(report.fileKey);
    const fileName = report.fileKey.split('/').pop() ?? report.fileKey;
    const contentType = fileName.endsWith('.pdf') ? 'application/pdf' : 'text/csv; charset=utf-8';
    return { fileName, contentType, body };
  }

  // ---------------------------------------------------------------------------------------
  // Schedules — TZ §15 "Report scheduler (BullMQ)": cron-like definitions persisted in the DB
  // ---------------------------------------------------------------------------------------

  async createSchedule(dto: CreateReportScheduleDto, actor: ContextUser): Promise<ReportSchedule> {
    this.assertFormatAllowed(dto.reportType, dto.format);
    const nextRunAt = this.computeNextRun(dto.cron, dto.timezone);
    // CODE-015 — the scheduler hands these params to the worker on every run, so they get the
    // same per-type validation (range caps included) as `generate()`, not only at run time.
    const params = assertScheduleParams(dto.reportType, dto.params, dto.timezone);
    return this.schedules.create({
      reportType: dto.reportType,
      format: dto.format,
      params: params as object,
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
    const cron = dto.cron ?? existing.cron;
    const timezone = dto.timezone ?? existing.timezone;
    // CODE-015 — validate the schedule as it will be AFTER this patch (a format-only or type-only
    // change is checked against the stored other half), then its params against the final type.
    const reportType = dto.reportType ?? (existing.reportType as CreateReportScheduleDto['reportType']);
    const format = dto.format ?? existing.format;
    if (dto.reportType || dto.format) this.assertFormatAllowed(reportType, format);
    const params =
      dto.reportType || dto.params || dto.timezone
        ? assertScheduleParams(reportType, dto.params ?? (existing.params as Record<string, unknown>), timezone)
        : undefined;
    // Resuming a paused schedule recomputes `nextRunAt` from now, so a stale past date does not
    // make the scheduler fire a catch-up run the moment it is re-enabled.
    const resuming = dto.enabled === true && !existing.enabled;
    const nextRunAt = dto.cron || dto.timezone || resuming ? this.computeNextRun(cron, timezone) : undefined;
    return this.schedules.update(
      { id },
      {
        ...(dto.reportType ? { reportType: dto.reportType } : {}),
        ...(dto.format ? { format: dto.format } : {}),
        ...(params ? { params: params as object } : {}),
        ...(dto.cron ? { cron: dto.cron } : {}),
        ...(dto.timezone ? { timezone: dto.timezone } : {}),
        ...(dto.recipients ? { recipients: dto.recipients } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
      },
    );
  }

  async deleteSchedule(id: string): Promise<void> {
    const existing = await this.schedules.findById({ id });
    if (!existing) throw AppException.notFound('Report schedule not found.');
    await this.schedules.delete({ id });
  }

  computeNextRun(cron: string, timezone: string, from: Date = new Date()): Date {
    try {
      const interval = cronParser.parseExpression(cron, { currentDate: from, tz: timezone });
      return interval.next().toDate();
    } catch {
      throw new AppException(ERROR_CODES.INVALID_CRON_EXPRESSION, `"${cron}" is not a valid 5-field cron expression.`, 422);
    }
  }

  /** B-48 — `IFTA`/`ACTIVITY`/`DVIR` now allow CSV or PDF; `FMCSA_PACK`/`RODS`/`IDLE_FUEL`
   * stay single-format (see `REPORT_TYPE_FORMATS`). */
  private assertFormatAllowed(type: string, format: string): void {
    const allowed = REPORT_TYPE_FORMATS[type as keyof typeof REPORT_TYPE_FORMATS];
    if (!allowed?.includes(format as 'CSV' | 'PDF')) {
      throw AppException.unprocessable(
        ERROR_CODES.VALIDATION_FAILED,
        `${type} reports support ${allowed?.join('/') ?? 'no'} format(s) in this version, not "${format}".`,
      );
    }
  }
}

/** CODE-016 — FMCSA audit packs need `reportsTransfer` READ (as `GET /reports/fmcsa-pack`), not
 * just `reports`. Drivers never reach these routes; an absent matrix is no access. */
export function mayAccessFmcsaPack(actor: ContextUser): boolean {
  const level = actor.permissions?.reportsTransfer ?? 'NONE';
  return PERMISSION_LEVEL_RANK[level] >= PERMISSION_LEVEL_RANK.READ;
}

function assertMayAccessFmcsaPack(actor: ContextUser): void {
  if (!mayAccessFmcsaPack(actor)) throw AppException.forbidden('reportsTransfer = READ is required for the FMCSA audit pack.');
}

const REPORT_PARAM_SCHEMAS = {
  IFTA: IftaReportParamsDto,
  ACTIVITY: ActivityReportParamsDto,
  DVIR: DvirReportParamsDto,
  FMCSA_PACK: FmcsaPackParamsDto,
  RODS: RodsReportParamsDto,
  IDLE_FUEL: IdleFuelReportParamsDto,
} as const;

/** B-46 — shapes the `User` relation loaded by `REQUESTED_BY_INCLUDE` into `{ id, name }`;
 * never leaks the rest of the `User` row (email, roleId, ...) into a report response. */
function withRequestedBy<T extends { requestedBy?: { id: string; firstName: string; lastName: string } | null }>(
  report: T,
): Omit<T, 'requestedBy'> & { requestedBy: { id: string; name: string } | null } {
  const { requestedBy, ...rest } = report;
  return {
    ...rest,
    requestedBy: requestedBy ? { id: requestedBy.id, name: `${requestedBy.firstName} ${requestedBy.lastName}` } : null,
  };
}

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

/**
 * CODE-015 — a schedule's params, checked the way the worker will see them: a relative `window`
 * must be a known one, and the params resolved for a run NOW must pass the report type's own
 * schema (required fields, range caps). Returns what is stored: the parsed params, keeping the
 * `window` instead of the concrete period it resolved to this time.
 */
export function assertScheduleParams(
  type: keyof typeof REPORT_PARAM_SCHEMAS,
  params: Record<string, unknown>,
  timezone: string,
): Record<string, unknown> {
  const window = params.window;
  if (window !== undefined && !(REPORT_WINDOWS as readonly unknown[]).includes(window)) {
    throw AppException.unprocessable(ERROR_CODES.VALIDATION_FAILED, `Invalid ${type} report params.`, {
      issues: [{ path: 'window', message: `Must be one of ${REPORT_WINDOWS.join(', ')}.` }],
    });
  }
  const resolved = assertReportParams(type, resolveScheduleParams(type, params, timezone, new Date())) as Record<string, unknown>;
  if (window === undefined) return resolved;
  const { from: _from, to: _to, quarter: _quarter, ...rest } = resolved;
  return { ...rest, window };
}
