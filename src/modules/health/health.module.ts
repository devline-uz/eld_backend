import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthRepository } from './health.repository';
import { HealthService } from './health.service';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';
import { QueueDepthService } from './queue-depth.service';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

/**
 * API imports this for the `/health/*` + `/metrics` controller (see `HealthController`) and
 * `QueueDepthService` (polls BullMQ depth for the "queue backlog" alert — API always has the
 * queues registered via `QueueModule`, whether or not it's the consumer). `worker.ts` imports
 * it too, but for `HealthService`/`MetricsService`/`WorkerHeartbeatService` only — the worker
 * has no Nest HTTP stack, so it wires its own bare `http` listener around these providers (see
 * `worker.ts`) rather than mounting `HealthController`.
 */
@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    HealthRepository,
    MetricsService,
    MetricsInterceptor,
    WorkerHeartbeatService,
    QueueDepthService,
  ],
  exports: [MetricsService, MetricsInterceptor, HealthService, WorkerHeartbeatService],
})
export class HealthModule {}
