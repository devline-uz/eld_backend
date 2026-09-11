import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { RedisThrottlerStorage, type ThrottlerRedisClient } from './redis-throttler.storage';
import {
  isIngestRequest,
  resolveDriverTracker,
  resolveIpTracker,
  type TrackableRequest,
} from './principal-tracker';

/** Name of the §6.5 "ingest 300/daq/driver" bucket. */
export const INGEST_THROTTLER = 'ingest';

/** TZ §6.5 — "API 600/daq", the default bucket every route inherits. */
export const DEFAULT_LIMIT_PER_MIN = 600;

/** TZ §6.5 — "ingest 300/daq/driver". One bucket for all four §7.1 endpoints together. */
export const INGEST_LIMIT_PER_DRIVER_PER_MIN = 300;

export interface ThrottlerEnv {
  isTest: boolean;
  redisUrl?: string;
  redisDb?: number;
}

function requestOf(context: ExecutionContext): TrackableRequest {
  return context.switchToHttp().getRequest<TrackableRequest>();
}

/**
 * TZ §6.5 buckets.
 *
 * - `default` — 600/min keyed by IP. Unchanged; `AuthController` narrows the login family to
 *   5/min/IP and `IngestController` widens itself to 400/s (B-037: §19 wants 300 req/s peak
 *   fleet-wide and the whole fleet shares one depot NAT).
 * - `ingest` — 300/min keyed by DRIVER, only on `/ingest/*` (B-033). This is a per-driver
 *   budget, so it does not cap the fleet: at 300/min a single driver may push 5 req/s, and the
 *   §19 fleet target of 300 req/s peak is reachable from 60 concurrent drivers (a real fleet
 *   posting 500-event batches needs a small fraction of that).
 *
 * Both `skipIf`s honour NODE_ENV=test so e2e suites can hammer routes; note that a
 * per-throttler `skipIf` REPLACES the common one in `ThrottlerGuard`, hence the repetition.
 */
export function buildThrottlerOptions(env: ThrottlerEnv): ThrottlerModuleOptions {
  const skipInTest = (): boolean => env.isTest;
  return {
    storage: createThrottlerStorage(env),
    skipIf: skipInTest,
    throttlers: [
      {
        name: 'default',
        ttl: 60_000,
        limit: DEFAULT_LIMIT_PER_MIN,
        getTracker: (req: TrackableRequest) => resolveIpTracker(req),
      },
      {
        name: INGEST_THROTTLER,
        ttl: 60_000,
        limit: INGEST_LIMIT_PER_DRIVER_PER_MIN,
        skipIf: (context) => env.isTest || !isIngestRequest(requestOf(context)),
        getTracker: (req: TrackableRequest) => resolveDriverTracker(req),
        // Deliberately NOT the default `Class-handler-name` key: §6.5's budget is per driver
        // across events + telemetry + ble-state + device-status, not per endpoint.
        generateKey: (_context, tracker) => `${INGEST_THROTTLER}:${tracker}`,
      },
    ],
  };
}

/**
 * Redis-backed counters (TZ §3.3 — several API containers share one limit). Falls back to
 * @nestjs/throttler's in-memory store only under NODE_ENV=test or when no REDIS_URL is
 * configured, where a per-process counter is harmless.
 */
export function createThrottlerStorage(env: ThrottlerEnv): RedisThrottlerStorage | undefined {
  if (env.isTest || !env.redisUrl) return undefined;
  const client: ThrottlerRedisClient = new Redis(env.redisUrl, {
    db: env.redisDb ?? 0,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  return new RedisThrottlerStorage(client);
}
