import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Gauge } from 'prom-client';
import type { Queue } from 'bullmq';
import { ModuleRef } from '@nestjs/core';
import { AppConfigService } from '../../core/config/config.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { MetricsService } from './metrics.service';

/**
 * API container — TZ §22.5 "HOS recalculation queue depth > 500" alert (and the same signal
 * for every other queue: a backlog anywhere means the worker has stopped keeping up, whether
 * because it crashed (B-024) or is just overloaded). Polls BullMQ job counts rather than
 * listening for events, since depth is a level, not something that happens once per job.
 */
@Injectable()
export class QueueDepthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueDepthService.name);
  private timer?: NodeJS.Timeout;
  private readonly depth: Gauge<'queue' | 'state'>;

  constructor(
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.depth = new Gauge({
      name: 'onebook_queue_depth',
      help: 'BullMQ job count per queue and state (waiting/active/delayed/failed)',
      labelNames: ['queue', 'state'] as const,
      registers: [this.metrics.registry],
    });
  }

  onModuleInit(): void {
    if (this.config.isTest) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 15_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private poll(): void {
    for (const queueName of Object.values(QUEUES)) {
      let queue: Queue | undefined;
      try {
        queue = this.moduleRef.get<Queue>(getQueueToken(queueName), { strict: false });
      } catch {
        continue;
      }
      if (!queue) continue;
      queue
        .getJobCounts('waiting', 'active', 'delayed', 'failed')
        .then((counts) => {
          for (const [state, count] of Object.entries(counts)) {
            this.depth.set({ queue: queueName, state }, count);
          }
        })
        .catch((err: unknown) => this.logger.warn({ err, queue: queueName }, 'queue depth poll failed'));
    }
  }
}
