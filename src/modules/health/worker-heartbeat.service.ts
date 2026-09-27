import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Gauge, Counter } from 'prom-client';
import { Queue, QueueEvents } from 'bullmq';
import { AppConfigService } from '../../core/config/config.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { SentryService } from '../../core/observability/sentry.service';
import { describeError } from '../../core/observability/describe-error';
import { MetricsService } from './metrics.service';

/**
 * Worker container only (`worker.ts`) — TZ §22.5 / B-024. `worker.ts` has no HTTP stack and
 * previously had no way to prove it was actually consuming jobs: the compose healthcheck
 * (`node -e "process.exit(0)"`) only proved the process existed, which is exactly the signal
 * that stayed green for however long B-024 (a DI wiring bug that crashed `WorkerAppModule` at
 * boot before it ever started) went unnoticed on any environment that ran `node dist/worker.js`.
 *
 * This service gives Prometheus/Alertmanager and `/health/live` (on WORKER_HEALTH_PORT, see
 * `worker.ts`) two independent, real signals instead:
 *   1. `onebook_worker_heartbeat_timestamp_seconds` — ticks every 15s once
 *      `WorkerAppModule` finished booting. A worker that crashed during boot (B-024's failure
 *      mode) never sets this at all; a worker whose event loop is wedged stops updating it.
 *   2. `onebook_worker_queue_last_completed_timestamp_seconds{queue}` /
 *      `onebook_worker_queue_failed_jobs_total{queue}` — per-queue BullMQ `QueueEvents`
 *      listeners, so "queue has a backlog but nothing is completing" is directly visible per
 *      queue, not just process-presence.
 */
@Injectable()
export class WorkerHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private timer?: NodeJS.Timeout;
  private readonly listeners: QueueEvents[] = [];
  /** Lazily opened, only to read a failed job's stacktrace when `failedReason` is empty. */
  private readonly lookupQueues = new Map<string, Queue>();
  private lastHeartbeatMs = 0;

  private readonly heartbeat: Gauge<string>;
  private readonly lastCompleted: Gauge<'queue'>;
  private readonly failedTotal: Counter<'queue'>;

  constructor(
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
    private readonly sentry: SentryService,
  ) {
    this.heartbeat = new Gauge({
      name: 'onebook_worker_heartbeat_timestamp_seconds',
      help: 'Unix timestamp (seconds) of the last worker heartbeat tick; a stale value means the worker process is wedged or down',
      registers: [this.metrics.registry],
    });
    this.lastCompleted = new Gauge({
      name: 'onebook_worker_queue_last_completed_timestamp_seconds',
      help: 'Unix timestamp (seconds) of the last job this worker completed, per queue',
      labelNames: ['queue'] as const,
      registers: [this.metrics.registry],
    });
    this.failedTotal = new Counter({
      name: 'onebook_worker_queue_failed_jobs_total',
      help: 'Total jobs that reached their final failure (all retries exhausted), per queue',
      labelNames: ['queue'] as const,
      registers: [this.metrics.registry],
    });
  }

  onModuleInit(): void {
    if (this.config.isTest) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref?.();

    for (const queue of Object.values(QUEUES)) {
      const events = new QueueEvents(queue, {
        connection: { url: this.config.get('REDIS_URL'), db: this.config.get('REDIS_DB') },
        prefix: this.config.get('QUEUE_PREFIX'),
      });
      events.on('completed', () => this.lastCompleted.set({ queue }, Date.now() / 1000));
      events.on('failed', ({ jobId, failedReason }) => {
        this.failedTotal.inc({ queue });
        void this.reportFailure(queue, jobId, failedReason);
      });
      events.on('error', (err) => this.logger.warn({ err, queue }, 'QueueEvents connection error'));
      this.listeners.push(events);
    }
    this.logger.log('Worker heartbeat + per-queue completion/failure metrics started');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.listeners.map((e) => e.close().catch(() => undefined)));
    await Promise.all([...this.lookupQueues.values()].map((q) => q.close().catch(() => undefined)));
  }

  /**
   * `worker.job_failed` must always carry the real error. `failedReason` is BullMQ's copy of
   * `err.message`, which is "" for e.g. a Node `AggregateError [ECONNREFUSED]`. In that case
   * read the job's stored `stacktrace` (whose first line names the error) so the log/Sentry
   * record is never blank.
   */
  private async reportFailure(queue: string, jobId: string | undefined, failedReason: string | undefined): Promise<void> {
    let reason = (failedReason ?? '').trim();
    let stack: string | undefined;
    let jobName: string | undefined;
    let attemptsMade: number | undefined;
    if (jobId) {
      try {
        const q = this.lookupQueue(queue);
        const job = await q.getJob(jobId);
        if (job) {
          jobName = job.name;
          attemptsMade = job.attemptsMade;
          const traces = Array.isArray(job.stacktrace) ? job.stacktrace.filter(Boolean) : [];
          stack = traces[traces.length - 1];
          if (!reason) reason = (job.failedReason ?? '').trim();
        }
      } catch (err) {
        this.logger.warn({ queue, jobId, error: describeError(err) }, 'could not load failed job details');
      }
    }
    if (!reason) reason = stack?.split('\n')[0]?.trim() || '(no error message recorded)';
    try {
      this.sentry.capture({
        message: 'worker.job_failed',
        level: 'error',
        fingerprint: ['worker_job_failed', queue],
        tags: { queue },
        extra: { jobId, jobName, attemptsMade, failedReason: reason, stack },
      });
    } catch {
      /* capture never throws, but a listener must not crash the worker */
    }
  }

  private lookupQueue(queue: string): Queue {
    let q = this.lookupQueues.get(queue);
    if (!q) {
      q = new Queue(queue, {
        connection: { url: this.config.get('REDIS_URL'), db: this.config.get('REDIS_DB') },
        prefix: this.config.get('QUEUE_PREFIX'),
      });
      q.on('error', (err) => this.logger.warn({ queue, error: describeError(err) }, 'lookup Queue connection error'));
      this.lookupQueues.set(queue, q);
    }
    return q;
  }

  private tick(): void {
    this.lastHeartbeatMs = Date.now();
    this.heartbeat.set(this.lastHeartbeatMs / 1000);
  }

  /** Used by the worker's own `/health/live` handler — stale beyond ~2 intervals = not ticking. */
  isAlive(maxStaleMs = 45_000): boolean {
    if (this.config.isTest) return true;
    return this.lastHeartbeatMs > 0 && Date.now() - this.lastHeartbeatMs < maxStaleMs;
  }
}
