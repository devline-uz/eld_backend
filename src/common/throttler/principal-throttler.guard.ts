import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';
import { INGEST_THROTTLER } from './throttler.options';

/**
 * TZ §6.5 / §20 — the only difference from `ThrottlerGuard` is the rejection shape: the
 * project's error envelope (`RATE_LIMITED` + `details`) instead of Nest's bare
 * `ThrottlerException`, so a 429 from the ingest bucket is machine-readable by the app and
 * it can back off on the right scope (`driver` vs `ip`).
 *
 * The tracker/bucket configuration itself lives in `throttler.options.ts` (per-throttler
 * `getTracker`), so both this guard and a plain `ThrottlerGuard` behave identically apart
 * from the envelope.
 */
@Injectable()
export class PrincipalThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    _context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const isIngest = detail.key.startsWith(`${INGEST_THROTTLER}:`);
    const scope = detail.tracker.startsWith('driver:') ? 'driver' : 'ip';
    throw new AppException(
      ERROR_CODES.RATE_LIMITED,
      isIngest
        ? `Ingest rate limit exceeded for this ${scope} (${detail.limit} requests per ${Math.round(detail.ttl / 1000)}s).`
        : `Rate limit exceeded (${detail.limit} requests per ${Math.round(detail.ttl / 1000)}s).`,
      HttpStatus.TOO_MANY_REQUESTS,
      {
        scope,
        limit: detail.limit,
        windowSec: Math.round(detail.ttl / 1000),
        retryAfterSec: detail.timeToBlockExpire || detail.timeToExpire,
      },
    );
  }
}
