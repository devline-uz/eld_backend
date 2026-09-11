import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { IngestController } from '../../modules/ingest/ingest.controller';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';
import { PrincipalThrottlerGuard } from './principal-throttler.guard';
import {
  decodeTokenSubject,
  isIngestRequest,
  resolveDriverTracker,
  resolveIpTracker,
} from './principal-tracker';
import {
  buildThrottlerOptions,
  createThrottlerStorage,
  DEFAULT_LIMIT_PER_MIN,
  INGEST_LIMIT_PER_DRIVER_PER_MIN,
} from './throttler.options';
import { RedisThrottlerStorage } from './redis-throttler.storage';

const SHARED_IP = '203.0.113.7'; // one carrier-NAT egress address for the whole fleet

function driverToken(driverId: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: driverId, type: 'driver' })).toString(
    'base64url',
  );
  return `Bearer header.${payload}.signature`;
}

function ingestContext(driverId: string, ip = SHARED_IP, url = '/v1/ingest/events'): ExecutionContext {
  const req = { ip, originalUrl: url, headers: { authorization: driverToken(driverId) } };
  const res = { header: (): void => undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getClass: () => IngestController,
    getHandler: () => IngestController.prototype.events,
  } as unknown as ExecutionContext;
}

/** A non-ingest route carrying the same driver token (the `ingest` bucket must not apply). */
function otherContext(driverId: string, ip = SHARED_IP): ExecutionContext {
  const req = { ip, originalUrl: '/v1/mobile/bootstrap', headers: { authorization: driverToken(driverId) } };
  const res = { header: (): void => undefined };
  class MobileController {
    bootstrap(): void {}
  }
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getClass: () => MobileController,
    getHandler: () => MobileController.prototype.bootstrap,
  } as unknown as ExecutionContext;
}

async function makeGuard(): Promise<{ guard: PrincipalThrottlerGuard; storage: ThrottlerStorageService }> {
  const storage = new ThrottlerStorageService();
  const guard = new PrincipalThrottlerGuard(
    buildThrottlerOptions({ isTest: false }),
    storage,
    new Reflector(),
  );
  await guard.onModuleInit();
  return { guard, storage };
}

async function hit(guard: PrincipalThrottlerGuard, ctx: ExecutionContext): Promise<'ok' | AppException> {
  try {
    await guard.canActivate(ctx);
    return 'ok';
  } catch (error) {
    return error as AppException;
  }
}

describe('TZ §6.5 — per-driver ingest rate limit (B-033)', () => {
  let guard: PrincipalThrottlerGuard;
  let storage: ThrottlerStorageService;

  beforeEach(async () => {
    ({ guard, storage } = await makeGuard());
  });

  afterEach(() => storage.onApplicationShutdown());

  it('blocks a driver past 300 ingest requests/min while a second driver on the SAME IP is untouched', async () => {
    for (let i = 0; i < INGEST_LIMIT_PER_DRIVER_PER_MIN; i++) {
      expect(await hit(guard, ingestContext('drv_noisy'))).toBe('ok');
    }

    const rejected = await hit(guard, ingestContext('drv_noisy'));
    expect(rejected).toBeInstanceOf(AppException);
    const exception = rejected as AppException;
    expect(exception.getStatus()).toBe(429);
    expect(exception.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(exception.details).toMatchObject({
      scope: 'driver',
      limit: INGEST_LIMIT_PER_DRIVER_PER_MIN,
      windowSec: 60,
    });

    // The whole point of B-033: the noisy device's budget is its own, not the fleet's.
    expect(await hit(guard, ingestContext('drv_quiet'))).toBe('ok');
    expect(await hit(guard, ingestContext('drv_quiet'))).toBe('ok');
  });

  it('spends one bucket across all four §7.1 endpoints for the same driver', async () => {
    const urls = [
      '/v1/ingest/events',
      '/v1/ingest/telemetry',
      '/v1/ingest/ble-state',
      '/v1/ingest/device-status',
    ];
    for (let i = 0; i < INGEST_LIMIT_PER_DRIVER_PER_MIN; i++) {
      expect(await hit(guard, ingestContext('drv_mixed', SHARED_IP, urls[i % 4]))).toBe('ok');
    }
    const rejected = await hit(guard, ingestContext('drv_mixed', SHARED_IP, '/v1/ingest/ble-state'));
    expect(rejected).toBeInstanceOf(AppException);
  });

  it('keeps the §19 fleet throughput reachable: 300 req/s peak over 60 drivers, all accepted', async () => {
    // 300/min/driver = 5 req/s/driver; 60 drivers × 5 = the §19 peak target of 300 req/s.
    const drivers = 60;
    const perDriverPerSecond = INGEST_LIMIT_PER_DRIVER_PER_MIN / 60;
    expect(drivers * perDriverPerSecond).toBeGreaterThanOrEqual(300);

    let accepted = 0;
    for (let d = 0; d < drivers; d++) {
      for (let r = 0; r < perDriverPerSecond; r++) {
        if ((await hit(guard, ingestContext(`drv_${d}`))) === 'ok') accepted++;
      }
    }
    expect(accepted).toBe(300);
  });

  it("keeps B-037's per-route 400 req/s IP ceiling above the §19 peak", () => {
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', IngestController) as number;
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', IngestController) as number;
    expect(limit).toBe(400);
    expect(ttl).toBe(1000);
    expect(limit / (ttl / 1000)).toBeGreaterThan(300);
  });

  it('does not apply the ingest bucket to non-ingest routes (default 600/min/IP still governs)', async () => {
    for (let i = 0; i < INGEST_LIMIT_PER_DRIVER_PER_MIN + 50; i++) {
      expect(await hit(guard, otherContext('drv_web'))).toBe('ok');
    }
    expect(DEFAULT_LIMIT_PER_MIN).toBe(600);
  });

  it('skips both buckets under NODE_ENV=test', async () => {
    const testGuard = new PrincipalThrottlerGuard(
      buildThrottlerOptions({ isTest: true }),
      storage,
      new Reflector(),
    );
    await testGuard.onModuleInit();
    for (let i = 0; i < INGEST_LIMIT_PER_DRIVER_PER_MIN + 10; i++) {
      expect(await hit(testGuard, ingestContext('drv_e2e'))).toBe('ok');
    }
  });
});

describe('principal trackers', () => {
  it('keys an authenticated driver by id and an anonymous caller by IP', () => {
    expect(resolveDriverTracker({ ip: '1.2.3.4', user: { id: 'drv_1', type: 'driver' } })).toBe(
      'driver:drv_1',
    );
    expect(
      resolveDriverTracker({ ip: '1.2.3.4', headers: { authorization: driverToken('drv_2') } }),
    ).toBe('driver:drv_2');
    expect(resolveDriverTracker({ ip: '1.2.3.4', headers: {} })).toBe('ip:1.2.3.4');
    expect(resolveIpTracker({ ips: ['9.9.9.9'] })).toBe('ip:9.9.9.9');
    expect(resolveIpTracker({})).toBe('ip:unknown');
  });

  it('never throws on a malformed Authorization header', () => {
    expect(decodeTokenSubject(undefined)).toBeNull();
    expect(decodeTokenSubject('Basic abc')).toBeNull();
    expect(decodeTokenSubject('Bearer not-a-jwt')).toBeNull();
    expect(decodeTokenSubject('Bearer a.%%%.c')).toBeNull();
    expect(decodeTokenSubject(`Bearer a.${Buffer.from('{}').toString('base64url')}.c`)).toBeNull();
  });

  it('recognises the four §7.1 ingest paths whatever the API prefix', () => {
    expect(isIngestRequest({ originalUrl: '/v1/ingest/events' })).toBe(true);
    expect(isIngestRequest({ url: '/api/v1/ingest/device-status?x=1' })).toBe(true);
    expect(isIngestRequest({ originalUrl: '/v1/logs/ingested' })).toBe(false);
    expect(isIngestRequest({})).toBe(false);
  });
});

describe('RedisThrottlerStorage', () => {
  it('returns seconds and blocks once the limit is passed', async () => {
    const calls: (string | number)[][] = [];
    const storage = new RedisThrottlerStorage({
      eval: async (_s, _n, ...args) => {
        calls.push(args);
        return [301, 42_000, 1];
      },
    });
    await expect(storage.increment('ingest:driver:drv_1', 60_000, 300, 0, 'ingest')).resolves.toEqual(
      { totalHits: 301, timeToExpire: 42, isBlocked: true, timeToBlockExpire: 42 },
    );
    expect(calls[0]).toEqual(['throttle:ingest:driver:drv_1', 60_000, 300, 60_000]);
  });

  it('fails OPEN when Redis is unreachable — ELD ingest must never be dropped', async () => {
    const storage = new RedisThrottlerStorage({
      eval: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(storage.increment('k', 60_000, 300, 60_000, 'ingest')).resolves.toEqual({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('uses the in-memory store only in tests or without REDIS_URL', () => {
    expect(createThrottlerStorage({ isTest: true, redisUrl: 'redis://localhost:6379' })).toBeUndefined();
    expect(createThrottlerStorage({ isTest: false })).toBeUndefined();
    expect(createThrottlerStorage({ isTest: false, redisUrl: 'redis://localhost:63791', redisDb: 0 })).toBeInstanceOf(
      RedisThrottlerStorage,
    );
  });
});
