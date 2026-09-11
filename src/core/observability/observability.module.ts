import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { HealthModule } from '../../modules/health/health.module';
import { SentryService } from './sentry.service';

/**
 * TZ §19 / §22.5 — error reporting. `@Global()` + imported once by each composition root
 * (`app.module.ts` for the API, `worker.ts` for the worker) so `SentryService.onModuleInit()`
 * runs `Sentry.init()` exactly once per process, independent of which feature modules also
 * import this module to report anomalies (today: `hos-state`, §8.6 drift).
 *
 * Imports `HealthModule` (not global) so `SentryService` can mirror every capture into
 * `onebook_sentry_captures_total{fingerprint}` on the same Prometheus registry — this is what
 * makes anomalies like `alert.hos_engine_drift` (the §8.6 nightly sweep's per-driver drift
 * report) queryable over a multi-day window instead of only visible in the log stream.
 */
@Global()
@Module({
  imports: [AppConfigModule, HealthModule],
  providers: [SentryService],
  exports: [SentryService],
})
export class ObservabilityModule {}
