import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import { SafetyScoreService } from '../modules/safety/safety-score.service';

/**
 * D-141 — W-10 scorecards: recomputes `DriverScore` for the rolling 30-day period every night.
 * Same self-scheduling shape as `IftaNightlyProcessor`.
 *
 * 10:30 UTC: the period ends on the newest calendar day that is over in EVERY driver's home
 * terminal zone. At 10:30 UTC "yesterday" has ended across all US/CA zones (Hawaii midnight is
 * 10:00 UTC), so the period ends yesterday for everyone; it also runs after ifta-nightly (02:30),
 * hos-drift (03:20) and the overnight hos-recalc of late-synced logs, and before the US business
 * day starts in the east (05:30/06:30 ET).
 *
 * Job data `{ endDate?: 'YYYY-MM-DD' }` scores the period ending on that day instead (backfill /
 * one-off run: `npx ts-node scripts/enqueue-safety-score.ts [YYYY-MM-DD]`).
 */
export const SAFETY_SCORE_CRON = '30 10 * * *';
export const SAFETY_SCORE_JOB_NAME = 'safety.score';
export const SAFETY_SCORE_REPEAT_JOB_ID = 'safety-score-nightly';

@Processor(QUEUES.SAFETY_SCORE, { concurrency: 1 })
export class SafetyScoreProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SafetyScoreProcessor.name);

  constructor(
    private readonly scores: SafetyScoreService,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.SAFETY_SCORE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      await this.queue.add(
        SAFETY_SCORE_JOB_NAME,
        {},
        { repeat: { pattern: SAFETY_SCORE_CRON, tz: 'UTC' }, jobId: SAFETY_SCORE_REPEAT_JOB_ID, removeOnComplete: { count: 30 } },
      );
      this.logger.log({ cron: SAFETY_SCORE_CRON }, 'Nightly safety scorecard scheduled');
    } catch (err) {
      this.logger.error({ err }, 'Failed to schedule the nightly safety scorecard');
    }
  }

  async process(job: Job<{ endDate?: string }>): Promise<void> {
    const endDate = job.data?.endDate;
    if (endDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      this.logger.warn({ jobId: job.id, endDate }, 'safety.score ignored: endDate must be YYYY-MM-DD');
      return;
    }
    const result = await this.scores.run(new Date(), endDate);
    this.logger.log({ jobId: job.id, ...result }, 'safety.score processed');
  }
}
