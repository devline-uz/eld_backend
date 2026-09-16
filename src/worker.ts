import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as http from 'node:http';
import { Logger } from 'nestjs-pino';
import { AppConfigModule } from './core/config/config.module';
import { AppConfigService } from './core/config/config.service';
import { EventsModule } from './core/events/events.module';
import { FirebaseModule } from './core/firebase/firebase.module';
import { AppLoggerModule } from './core/logger/logger.module';
import { ObservabilityModule } from './core/observability/observability.module';
import { PrismaModule } from './core/prisma/prisma.module';
import { QueueModule } from './core/queue/queue.module';
import { StorageModule } from './core/storage/storage.module';
import { HealthModule } from './modules/health/health.module';
import { HealthService } from './modules/health/health.service';
import { MetricsService } from './modules/health/metrics.service';
import { WorkerHeartbeatService } from './modules/health/worker-heartbeat.service';
import { WorkersModule } from './workers/workers.module';

/**
 * Worker composition root. Same code base as the API (TZ §3.3) but deliberately WITHOUT
 * controllers, guards, filters or the Nest HTTP stack — a BullMQ processor has no request.
 * The db-guard still runs, because AppConfigModule is imported here too.
 *
 * `HealthModule` is imported for its providers only (see the bare `http` listener below) —
 * B-024: the worker container previously had no liveness signal beyond process-presence, so
 * a DI wiring bug that crashed boot before a single processor registered went unnoticed.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    ObservabilityModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    FirebaseModule,
    EventsModule,
    HealthModule,
    WorkersModule,
  ],
})
export class WorkerAppModule {}

/**
 * The worker has no Nest HTTP stack, so `/health/live`, `/health/ready`, `/health/deep` and
 * `/metrics` are served from a bare `http.Server` on `WORKER_HEALTH_PORT` (compose maps this
 * for the container healthcheck + Prometheus scrape — see `docker-compose.yml`). `/health/live`
 * is backed by `WorkerHeartbeatService.isAlive()`, not just "the process is up": a wedged event
 * loop or a worker that never finished booting both report unhealthy.
 */
function startHealthServer(
  config: AppConfigService,
  health: HealthService,
  metrics: MetricsService,
  heartbeat: WorkerHeartbeatService,
  logger: Logger,
): void {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.url === '/health/live') {
          const alive = heartbeat.isAlive();
          res.writeHead(alive ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: alive ? 'ok' : 'down' }));
        } else if (req.url === '/health/ready') {
          const result = await health.ready();
          res.writeHead(result.status === 'up' ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else if (req.url === '/health/deep') {
          const result = await health.deep();
          res.writeHead(result.status === 'up' ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else if (req.url === '/metrics') {
          res.writeHead(200, { 'Content-Type': metrics.contentType, 'Cache-Control': 'no-store' });
          res.end(await metrics.scrape());
        } else {
          res.writeHead(404).end();
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
      }
    })();
  });
  const port = config.get('WORKER_HEALTH_PORT');
  const host = config.get('WORKER_HEALTH_HOST');
  server.listen(port, host, () => logger.log(`Worker health/metrics listening on ${host}:${port}`));
}

async function bootstrap(): Promise<void> {
  // createApplicationContext = no HTTP listener from Nest itself; see startHealthServer above.
  const app = await NestFactory.createApplicationContext(WorkerAppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  startHealthServer(
    app.get(AppConfigService),
    app.get(HealthService),
    app.get(MetricsService),
    app.get(WorkerHeartbeatService),
    logger,
  );

  logger.log('Worker started — BullMQ processors registered');
}

void bootstrap();
