import { Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { SentryService } from './sentry.service';

/**
 * TZ §19 — error reporting seam. Imported by the modules that report anomalies (today:
 * `hos-state`, §8.6 drift). Phase 12 (`eld-devops`) replaces the body of `SentryService`
 * with the real `@sentry/node` client and may promote this module to `@Global()`.
 */
@Module({
  imports: [AppConfigModule],
  providers: [SentryService],
  exports: [SentryService],
})
export class ObservabilityModule {}
