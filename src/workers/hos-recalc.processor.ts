import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../core/queue/queue.constants';
import { HosRecalcService, type HosRecalcJobData } from '../modules/hos-recalc/hos-recalc.service';

/**
 * TZ §8.4 — `hos.recalc`. Runs in the worker container only (§3.3).
 *
 * Serialisation: BullMQ's `groupKey` is a Pro feature, so the OSS equivalent of "serial per
 * driver" is a single-slot worker — concurrency 1 (D-0xx). The job is idempotent anyway: every
 * violation write is an upsert on (driverId, logDate, type), so a duplicated or retried job
 * converges on the same rows instead of inflating the open-violation counter.
 */
@Processor(QUEUES.HOS_RECALC, { concurrency: 1 })
export class HosRecalcProcessor extends WorkerHost {
  private readonly logger = new Logger(HosRecalcProcessor.name);

  constructor(private readonly recalc: HosRecalcService) {
    super();
  }

  async process(job: Job<HosRecalcJobData>): Promise<void> {
    const { driverId } = job.data;
    if (!driverId) {
      this.logger.warn({ jobId: job.id }, 'hos.recalc without a driverId — dropped');
      return;
    }
    const result = await this.recalc.recalculate(job.data);
    this.logger.debug({ jobId: job.id, driverId, days: result.days.length, upserted: result.upserted, autoCleared: result.autoCleared }, 'hos.recalc processed');
  }
}
