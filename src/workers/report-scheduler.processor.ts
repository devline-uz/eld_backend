import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import { PrismaService } from '../core/prisma/prisma.service';
import { resolveScheduleParams } from '../modules/reports/lib/report-window';
import { ReportSchedulesRepository } from '../modules/reports/reports.repository';
import { ReportsService, type ReportJobData } from '../modules/reports/reports.service';

/**
 * TZ §15 "Done when" — the report scheduler must run scheduled reports WITHOUT a manual
 * trigger; cron-like definitions live in `ReportSchedule` (DB), not in code. Same
 * self-scheduling shape as `MaintenanceDueProcessor`/`HosDriftProcessor`: this processor
 * repeats itself every minute and, on each tick, enqueues a `report.generate` job for every
 * `ReportSchedule` whose `nextRunAt <= now`, then advances `nextRunAt` from its cron.
 */
export const REPORT_SCHEDULER_TICK_CRON = '* * * * *';
export const REPORT_SCHEDULER_JOB_NAME = 'report-schedule.tick';
export const REPORT_SCHEDULER_REPEAT_JOB_ID = 'report-scheduler-tick';

export interface ReportSchedulerTickResult {
  due: number;
  enqueued: number;
}

@Processor(QUEUES.REPORT_SCHEDULER, { concurrency: 1 })
export class ReportSchedulerProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ReportSchedulerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedulesRepo: ReportSchedulesRepository,
    private readonly reportsService: ReportsService,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.REPORT_SCHEDULER) private readonly tickQueue: Queue,
    @InjectQueue(QUEUES.REPORT) private readonly queue: Queue<ReportJobData>,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      await this.tickQueue.add(
        REPORT_SCHEDULER_JOB_NAME,
        {},
        { repeat: { pattern: REPORT_SCHEDULER_TICK_CRON, tz: 'UTC' }, jobId: REPORT_SCHEDULER_REPEAT_JOB_ID, removeOnComplete: { count: 30 } },
      );
      this.logger.log({ cron: REPORT_SCHEDULER_TICK_CRON }, 'Report scheduler tick registered');
    } catch (err) {
      this.logger.error({ err }, 'Failed to schedule the report-schedule tick');
    }
  }

  async process(job: Job): Promise<void> {
    if (job.name !== REPORT_SCHEDULER_JOB_NAME) return;
    const result = await this.runTick(new Date());
    this.logger.log({ jobId: job.id, ...result }, 'report-schedule.tick processed');
  }

  async runTick(now: Date): Promise<ReportSchedulerTickResult> {
    const due = await this.schedulesRepo.dueSchedules(now);
    let enqueued = 0;
    for (const schedule of due) {
      try {
        // CODE-080 — `createdById` has no FK, so a deleted owner made `report.create` fail on
        // every tick forever. Such a schedule is switched off once (and logged once) instead.
        if (!(await this.ownerExists(schedule.createdById))) {
          await this.schedulesRepo.update({ id: schedule.id }, { enabled: false, nextRunAt: null });
          this.logger.warn({ scheduleId: schedule.id, createdById: schedule.createdById }, 'Report schedule disabled: its owner no longer exists');
          continue;
        }
        // B-48 — `params.window` is resolved to a concrete `from`/`to` (or `quarter` for
        // IFTA) HERE, on each tick, in the schedule's own timezone — never once at
        // schedule-creation time, or every run would re-generate the same fixed period.
        const params = resolveScheduleParams(schedule.reportType, schedule.params as Record<string, unknown>, schedule.timezone, now);
        const report = await this.prisma.report.create({
          data: {
            type: schedule.reportType,
            format: schedule.format,
            // D-102: eslint's projectService type-checks this against a laxer Json type than
            // `tsc -p tsconfig.build.json` (the real build); without the cast `nest build` fails
            // with TS2322 (Record<string, unknown> not assignable to Prisma's InputJsonValue).
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            params: params as object,
            requestedById: schedule.createdById,
          },
        });
        // `scheduleId` tells report.processor to email the file to the schedule's recipients.
        await this.queue.add('report.generate', { reportId: report.id, scheduleId: schedule.id }, { jobId: `report-${report.id}` });
        const nextRunAt = this.reportsService.computeNextRun(schedule.cron, schedule.timezone, now);
        await this.schedulesRepo.update({ id: schedule.id }, { lastRunAt: now, nextRunAt });
        enqueued += 1;
      } catch (err) {
        this.logger.error({ err, scheduleId: schedule.id }, 'Failed to enqueue a scheduled report');
        await this.skipToNextRun(schedule, now);
      }
    }
    return { due: due.length, enqueued };
  }

  private async ownerExists(userId: string): Promise<boolean> {
    const owner = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    return owner !== null;
  }

  /** CODE-080 — a failed run still moves `nextRunAt` on, so one bad schedule is retried at its
   * next cron slot rather than on every one-minute tick. */
  private async skipToNextRun(schedule: { id: string; cron: string; timezone: string }, now: Date): Promise<void> {
    try {
      const nextRunAt = this.reportsService.computeNextRun(schedule.cron, schedule.timezone, now);
      await this.schedulesRepo.update({ id: schedule.id }, { nextRunAt });
    } catch (err) {
      this.logger.error({ err, scheduleId: schedule.id }, 'Failed to advance a failed report schedule');
    }
  }
}
