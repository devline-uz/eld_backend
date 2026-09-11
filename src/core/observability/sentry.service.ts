import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { Counter } from 'prom-client';
import { AppConfigService } from '../config/config.service';
import { RequestContext } from '../context/request-context';
import { MetricsService } from '../../modules/health/metrics.service';

export interface SentryCapture {
  /** Sentry "message" — a stable string, never interpolated with ids (that is what `tags` is for). */
  message: string;
  level?: 'info' | 'warning' | 'error';
  /** Grouping key. Sentry fingerprints; until the SDK lands it is part of the log record. */
  fingerprint?: string[];
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
}

/**
 * TZ §8.6 / §19 — the single place the backend reports an anomaly to Sentry.
 *
 * Wraps the real `@sentry/node` client (Phase 12, `eld-devops`): `onModuleInit()` calls
 * `Sentry.init()` once per process (API and worker each call it independently — separate
 * dev/prod projects per `SENTRY_DSN`/`SENTRY_ENVIRONMENT`), and `capture()` both forwards the
 * event to Sentry (when a DSN is configured) and still emits the structured, `sentry: true`
 * tagged log record every caller already relies on for local/dev visibility. Absence of
 * `SENTRY_DSN` is not an error: the Sentry client simply has nothing configured, so
 * `Sentry.captureMessage`/`captureException` become no-ops and the record stays in the log
 * stream only.
 */
@Injectable()
export class SentryService implements OnModuleInit {
  private readonly logger = new Logger(SentryService.name);
  private captured = 0;
  private readonly capturesTotal: Counter<'fingerprint'>;

  constructor(
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.capturesTotal = new Counter({
      name: 'onebook_sentry_captures_total',
      help: 'Anomalies reported via SentryService.capture(), by fingerprint — e.g. alert.hos_engine_drift, worker.job_failed. Makes multi-day drift/failure windows queryable in Prometheus instead of only in the log stream.',
      labelNames: ['fingerprint'] as const,
      registers: [this.metrics.registry],
    });
  }

  /** Idempotent-per-process: safe to call once from each of API and worker bootstrap. */
  onModuleInit(): void {
    if (!this.enabled) return;
    Sentry.init({
      dsn: this.config.get('SENTRY_DSN'),
      environment: this.config.get('SENTRY_ENVIRONMENT') ?? this.config.get('NODE_ENV'),
      tracesSampleRate: 0,
    });
  }

  get enabled(): boolean {
    return Boolean(this.config.get('SENTRY_DSN'));
  }

  /** Never throws: reporting an anomaly must not become a second anomaly. */
  capture(event: SentryCapture): void {
    this.captured += 1;
    try {
      this.capturesTotal.inc({ fingerprint: (event.fingerprint ?? [event.message])[0] });
    } catch {
      // A metrics registry failure must never propagate into a request or a BullMQ job.
    }
    const record = {
      sentry: true,
      sentryEnabled: this.enabled,
      level: event.level ?? 'error',
      fingerprint: event.fingerprint ?? [event.message],
      tags: event.tags ?? {},
      extra: event.extra ?? {},
      traceId: RequestContext.traceId,
    };
    try {
      if ((event.level ?? 'error') === 'error') this.logger.error(record, event.message);
      else this.logger.warn(record, event.message);
    } catch {
      // A logger transport failure must never propagate into a request or a BullMQ job.
    }
    try {
      if (this.enabled) {
        Sentry.withScope((scope) => {
          scope.setLevel(event.level === 'warning' ? 'warning' : event.level === 'info' ? 'info' : 'error');
          scope.setFingerprint(event.fingerprint ?? [event.message]);
          for (const [k, v] of Object.entries(event.tags ?? {})) scope.setTag(k, v);
          scope.setExtras(event.extra ?? {});
          if (RequestContext.traceId) scope.setTag('traceId', RequestContext.traceId);
          Sentry.captureMessage(event.message);
        });
      }
    } catch {
      // Sentry itself failing to accept an event must never propagate into a request/job.
    }
  }

  /** Test/diagnostic helper — how many captures this instance has seen. */
  get capturedCount(): number {
    return this.captured;
  }
}
