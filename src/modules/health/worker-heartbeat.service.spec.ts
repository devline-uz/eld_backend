interface FakeQueueEvents {
  handlers: Record<string, (arg?: unknown) => void>;
  on: jest.Mock;
  close: jest.Mock;
}

const instances: FakeQueueEvents[] = [];

const getJob = jest.fn();
const queueClose = jest.fn().mockResolvedValue(undefined);

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ getJob, on: jest.fn(), close: queueClose })),
  QueueEvents: jest.fn().mockImplementation((): FakeQueueEvents => {
    const instance: FakeQueueEvents = {
      handlers: {},
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    instance.on.mockImplementation((event: string, cb: (arg?: unknown) => void) => {
      instance.handlers[event] = cb;
      return instance;
    });
    instances.push(instance);
    return instance;
  }),
}));

import type { AppConfigService } from '../../core/config/config.service';
import type { SentryService } from '../../core/observability/sentry.service';
import { MetricsService } from './metrics.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

function buildConfig(isTest = false): jest.Mocked<Pick<AppConfigService, 'get' | 'isTest'>> {
  return {
    isTest,
    get: jest.fn((key: string) => {
      if (key === 'REDIS_URL') return 'redis://localhost:6379';
      if (key === 'REDIS_DB') return 1;
      if (key === 'QUEUE_PREFIX') return 'onebook';
      return undefined;
    }),
  } as unknown as jest.Mocked<Pick<AppConfigService, 'get' | 'isTest'>>;
}

describe('WorkerHeartbeatService', () => {
  beforeEach(() => {
    instances.length = 0;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing under NODE_ENV=test', () => {
    const config = buildConfig(true);
    const metrics = new MetricsService();
    const sentry = { capture: jest.fn() } as unknown as SentryService;
    const service = new WorkerHeartbeatService(config as unknown as AppConfigService, metrics, sentry);

    service.onModuleInit();

    expect(instances).toHaveLength(0);
    expect(service.isAlive()).toBe(true);
  });

  it('ticks on init and stays alive; stale after maxStaleMs passes', () => {
    const config = buildConfig(false);
    const metrics = new MetricsService();
    const sentry = { capture: jest.fn() } as unknown as SentryService;
    const service = new WorkerHeartbeatService(config as unknown as AppConfigService, metrics, sentry);

    service.onModuleInit();

    expect(service.isAlive()).toBe(true);
    expect(service.isAlive(-1)).toBe(false);
    // One QueueEvents listener per queue name.
    expect(instances.length).toBeGreaterThan(0);
  });

  it('records job completion and failure via QueueEvents, and reports failures to Sentry', async () => {
    const config = buildConfig(false);
    const metrics = new MetricsService();
    const sentry = { capture: jest.fn() } as unknown as SentryService;
    const service = new WorkerHeartbeatService(config as unknown as AppConfigService, metrics, sentry);

    service.onModuleInit();

    instances[0].handlers['completed']?.();
    instances[0].handlers['failed']?.({ failedReason: 'boom' });
    instances[0].handlers['error']?.(new Error('conn lost'));

    expect((sentry.capture as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'worker.job_failed' }),
    );

    const scraped = await metrics.scrape();
    expect(scraped).toContain('onebook_worker_heartbeat_timestamp_seconds');
    expect(scraped).toContain('onebook_worker_queue_failed_jobs_total');

    await service.onModuleDestroy();
    for (const inst of instances) expect(inst.close).toHaveBeenCalled();
  });

  it('never reports an empty failedReason — falls back to the job stacktrace', async () => {
    const config = buildConfig(false);
    const metrics = new MetricsService();
    const sentry = { capture: jest.fn() } as unknown as SentryService;
    const service = new WorkerHeartbeatService(config as unknown as AppConfigService, metrics, sentry);
    getJob.mockResolvedValueOnce({
      name: 'report.generate',
      attemptsMade: 3,
      failedReason: '',
      stacktrace: ['AggregateError [ECONNREFUSED]: \n    at internalConnectMultiple (node:net:1339:18)'],
    });

    service.onModuleInit();
    instances[instances.length - 1].handlers['failed']?.({ jobId: 'report-1', failedReason: '' });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(sentry.capture as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'worker.job_failed',
        extra: expect.objectContaining({
          jobId: 'report-1',
          jobName: 'report.generate',
          failedReason: 'AggregateError [ECONNREFUSED]:',
          stack: expect.stringContaining('internalConnectMultiple'),
        }),
      }),
    );
    await service.onModuleDestroy();
    expect(queueClose).toHaveBeenCalled();
  });
});
