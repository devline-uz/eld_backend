import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import { HosDriftService, type DriftSweepResult } from '../modules/hos-state/hos-drift.service';

/** §8.6 — "tungi job": 03:20 UTC, after the day has closed in every US timezone. */
export const HOS_DRIFT_CRON = '20 3 * * *';
export const HOS_DRIFT_JOB_NAME = 'hos.drift.nightly';
/** Fixed repeat key: re-registering on every worker boot updates the schedule, never duplicates it. */
export const HOS_DRIFT_REPEAT_JOB_ID = 'hos-drift-nightly';

/**
 * TZ §8.6 point 5 — compares every driver's server state with the last state their app posted
 * and raises `alert.hos_engine_drift` + Sentry above 60 s. Worker container only (§3.3).
 *
 * Concurrency 1: the sweep walks the whole `DriverHosSnapshot` table and two overlapping runs
 * would only duplicate alerts. The job is idempotent — it writes nothing but the comparison
 * columns of the snapshot it just measured.
 */
@Processor(QUEUES.HOS_DRIFT, { concurrency: 1 })
export class HosDriftProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(HosDriftProcessor.name);

  constructor(
    private readonly drift: HosDriftService,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.HOS_DRIFT) private readonly queue: Queue,
  ) {
    super();
  }

  /** Self-scheduling: the repeatable job is (re)declared by the worker that will run it. */
  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      await this.queue.add(
        HOS_DRIFT_JOB_NAME,
        {},
        {
          repeat: { pattern: HOS_DRIFT_CRON, tz: 'UTC' },
          jobId: HOS_DRIFT_REPEAT_JOB_ID,
          removeOnComplete: { count: 30 },
        },
      );
      this.logger.log({ cron: HOS_DRIFT_CRON }, 'Nightly HOS drift sweep scheduled');
    } catch (err) {
      // A worker that cannot reach Redis at boot must still start; BullMQ retries the connection.
      this.logger.error({ err }, 'Failed to schedule the nightly HOS drift sweep');
    }
  }

  async process(job: Job): Promise<DriftSweepResult> {
    const result = await this.drift.runNightlySweep();
    this.logger.log(
      { jobId: job.id, scanned: result.scanned, compared: result.compared, drifted: result.drifted, skippedVersion: result.skippedVersion },
      'hos.drift sweep processed',
    );
    return result;
  }
}
