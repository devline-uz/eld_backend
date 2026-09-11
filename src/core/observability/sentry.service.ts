import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { RequestContext } from '../context/request-context';

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
 * `@sentry/node` is NOT a dependency yet (observability wiring is Phase 12, `eld-devops`),
 * so this service is deliberately a SEAM: it emits one structured, `sentry: true` tagged
 * record through the Nest logger and counts captures for tests. When the SDK is added, only
 * `capture()` changes — no caller does. Absence of `SENTRY_DSN` is not an error: it just means
 * the record stays in the log stream.
 */
@Injectable()
export class SentryService {
  private readonly logger = new Logger(SentryService.name);
  private captured = 0;

  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return Boolean(this.config.get('SENTRY_DSN'));
  }

  /** Never throws: reporting an anomaly must not become a second anomaly. */
  capture(event: SentryCapture): void {
    this.captured += 1;
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
  }

  /** Test/diagnostic helper — how many captures this instance has seen. */
  get capturedCount(): number {
    return this.captured;
  }
}
