/** TZ §8.6 / §19 — the Sentry reporting seam. */
import type { AppConfigService } from '../config/config.service';
import { MetricsService } from '../../modules/health/metrics.service';
import { SentryService } from './sentry.service';

function build(dsn?: string): SentryService {
  const config = { get: jest.fn((key: string) => (key === 'SENTRY_DSN' ? dsn : undefined)) };
  return new SentryService(config as unknown as AppConfigService, new MetricsService());
}

describe('SentryService', () => {
  it('is disabled without a DSN and still captures', () => {
    const sentry = build(undefined);
    expect(sentry.enabled).toBe(false);
    sentry.capture({ message: 'HOS engine drift' });
    expect(sentry.capturedCount).toBe(1);
  });

  it('is enabled with a DSN', () => {
    expect(build('https://key@sentry.example/42').enabled).toBe(true);
  });

  it('counts every capture', () => {
    const sentry = build('https://key@sentry.example/42');
    sentry.capture({ message: 'a' });
    sentry.capture({ message: 'b', level: 'warning' });
    expect(sentry.capturedCount).toBe(2);
  });

  it('never throws when the logger transport fails', () => {
    const sentry = build(undefined);
    const logger = sentry as unknown as { logger: { error: () => void } };
    logger.logger.error = (): never => {
      throw new Error('transport down');
    };
    expect(() => sentry.capture({ message: 'boom' })).not.toThrow();
    expect(sentry.capturedCount).toBe(1);
  });

  it('accepts tags, extra and a fingerprint', () => {
    const sentry = build('https://key@sentry.example/42');
    expect(() =>
      sentry.capture({
        message: 'HOS engine drift',
        level: 'error',
        fingerprint: ['hos_engine_drift', '1.0.0'],
        tags: { driverId: 'd1' },
        extra: { maxDriftSec: 900 },
      }),
    ).not.toThrow();
  });
});
