import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { DateTime } from 'luxon';
import { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import { IftaSegmentsService } from '../modules/reports/ifta/ifta-segments.service';

/** TZ §15 warning box — `IftaSegment` is computed every night while telemetry still exists
 * (deleted after 13 months; IFTA audits reach back 4 years). Same self-scheduling shape as
 * `MaintenanceDueProcessor`. Runs at 02:30 UTC for "yesterday" (UTC day). */
export const IFTA_NIGHTLY_CRON = '30 2 * * *';
export const IFTA_NIGHTLY_JOB_NAME = 'ifta.nightly';
export const IFTA_NIGHTLY_REPEAT_JOB_ID = 'ifta-nightly';

@Processor(QUEUES.IFTA_NIGHTLY, { concurrency: 1 })
export class IftaNightlyProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(IftaNightlyProcessor.name);

  constructor(
    private readonly segments: IftaSegmentsService,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.IFTA_NIGHTLY) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      await this.queue.add(
        IFTA_NIGHTLY_JOB_NAME,
        {},
        { repeat: { pattern: IFTA_NIGHTLY_CRON, tz: 'UTC' }, jobId: IFTA_NIGHTLY_REPEAT_JOB_ID, removeOnComplete: { count: 30 } },
      );
      this.logger.log({ cron: IFTA_NIGHTLY_CRON }, 'Nightly IFTA segment computation scheduled');
    } catch (err) {
      this.logger.error({ err }, 'Failed to schedule the nightly IFTA segment computation');
    }
  }

  async process(job: Job<{ date?: string }>): Promise<void> {
    const date = job.data?.date ? DateTime.fromISO(job.data.date, { zone: 'utc' }) : DateTime.utc().minus({ days: 1 });
    const result = await this.segments.computeForDate(date.startOf('day'));
    this.logger.log({ jobId: job.id, ...result }, 'ifta.nightly processed');
  }
}
