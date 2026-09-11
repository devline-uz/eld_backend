import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

/** The only Redis surface this storage needs (keeps it unit-testable without a server). */
export interface ThrottlerRedisClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * One atomic INCR + PTTL, so N API containers share one counter (TZ §3.3 — the API runs as
 * more than one container; the in-memory `ThrottlerStorageService` would give each replica
 * its own budget and multiply every §6.5 limit by the replica count).
 *
 * `timeToExpire` / `timeToBlockExpire` are returned in SECONDS, matching
 * `ThrottlerStorageService` so the `X-RateLimit-*` headers keep their units.
 */
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
local blocked = 0
if hits > tonumber(ARGV[2]) then
  blocked = 1
  local block = tonumber(ARGV[3])
  if block > pttl then
    redis.call('PEXPIRE', KEYS[1], block)
    pttl = block
  end
end
return { hits, pttl, blocked }
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private failureLoggedAt = 0;

  constructor(
    private readonly redis: ThrottlerRedisClient,
    private readonly keyPrefix = 'throttle:',
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const raw = (await this.redis.eval(
        INCREMENT,
        1,
        `${this.keyPrefix}${key}`,
        ttl,
        limit,
        blockDuration || ttl,
      )) as [number, number, number];
      const [hits, pttlMs, blocked] = raw.map(Number) as [number, number, number];
      const timeToExpire = Math.ceil(pttlMs / 1000);
      const isBlocked = blocked === 1;
      return {
        totalHits: hits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire: isBlocked ? timeToExpire : 0,
      };
    } catch (error) {
      // Fail OPEN: a Redis blip must not stop §395 event ingest, which is the one thing the
      // carrier cannot legally lose. Logged at most once a minute to avoid log amplification.
      const now = Date.now();
      if (now - this.failureLoggedAt > 60_000) {
        this.failureLoggedAt = now;
        this.logger.warn(
          `Rate-limit storage unavailable, failing open: ${(error as Error)?.message ?? error}`,
        );
      }
      return { totalHits: 1, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
