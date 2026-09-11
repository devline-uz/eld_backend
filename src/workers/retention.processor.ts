import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import { RetentionService } from '../modules/retention/retention.service';

/** TZ §5.5/§18/§23 nightly retention sweep — worker container only (§3.3), same
 * self-scheduling shape as `MaintenanceDueProcessor`/`IftaNightlyProcessor`. Runs after the
 * IFTA nightly job (02:30 UTC) and the maintenance-due sweep (04:15 UTC) so it never races a
 * job still reading `EldEvent`/`AuditLog` for the same night. */
export const RETENTION_CRON = '30 4 * * *';
export const RETENTION_JOB_NAME = 'retention.nightly';
export const RETENTION_REPEAT_JOB_ID = 'retention-nightly';

export interface RetentionSweepResult {
  eldEvent: { scannedPartitions: number; droppedPartitions: string[]; skippedWithinWindow: number };
  auditLog: { eligible: number; archived: number; purged: number; skipped: boolean; reason?: string };
}

@Processor(QUEUES.RETENTION, { concurrency: 1 })
export class RetentionProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(RetentionProcessor.name);

  constructor(
    private readonly retention: RetentionService,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.RETENTION) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      await this.queue.add(
        RETENTION_JOB_NAME,
        {},
        { repeat: { pattern: RETENTION_CRON, tz: 'UTC' }, jobId: RETENTION_REPEAT_JOB_ID, removeOnComplete: { count: 30 } },
      );
      this.logger.log({ cron: RETENTION_CRON }, 'Nightly retention sweep scheduled');
    } catch (err) {
      this.logger.error({ err }, 'Failed to schedule the nightly retention sweep');
    }
  }

  async process(job: Job): Promise<RetentionSweepResult> {
    const eldEvent = await this.retention.sweepEldEvent();
    const auditLog = await this.retention.sweepAuditLog();
    const result: RetentionSweepResult = { eldEvent, auditLog };
    this.logger.log({ jobId: job.id, ...result }, 'retention.nightly processed');
    return result;
  }
}
