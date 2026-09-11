import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../../core/config/config.service';
import { S3StorageService } from '../../core/storage/s3-storage.service';
import { HealthRepository } from './health.repository';

export type CheckStatus = 'up' | 'down';

export interface DependencyCheck {
  status: CheckStatus;
  latencyMs: number;
  error?: string;
}

export interface DeepHealth {
  status: CheckStatus;
  uptimeSec: number;
  checks: Record<string, DependencyCheck>;
}

/** TZ §22.5 — live / ready / deep. */
@Injectable()
export class HealthService {
  private redis: Redis | null = null;

  constructor(
    private readonly repo: HealthRepository,
    private readonly config: AppConfigService,
    private readonly storage: S3StorageService,
  ) {}

  /** Process is alive; never touches a dependency. */
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Ready to serve traffic: DB reachable. */
  async ready(): Promise<{ status: CheckStatus; checks: Record<string, DependencyCheck> }> {
    const db = await timed(() => this.repo.pingDatabase());
    return { status: db.status, checks: { database: db } };
  }

  /** Full dependency sweep, run in parallel so the probe stays inside its timeout. */
  async deep(): Promise<DeepHealth> {
    const [database, redis, storage] = await Promise.all([
      timed(() => this.repo.pingDatabase()),
      timed(() => this.pingRedis()),
      timed(() => this.storage.ping()),
    ]);
    const checks = { database, redis, storage };
    const status: CheckStatus = Object.values(checks).every((c) => c.status === 'up')
      ? 'up'
      : 'down';
    return { status, uptimeSec: Math.round(process.uptime()), checks };
  }

  private async pingRedis(): Promise<boolean> {
    this.redis ??= new Redis(this.config.get('REDIS_URL'), {
      db: this.config.get('REDIS_DB'),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await this.redis.ping();
    return true;
  }
}

async function timed(fn: () => Promise<unknown>): Promise<DependencyCheck> {
  const startedAt = Date.now();
  try {
    await fn();
    return { status: 'up', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
