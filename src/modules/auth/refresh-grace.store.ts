import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { AppConfigService } from '../../core/config/config.service';

export interface GracePair {
  accessToken: string;
  refreshToken: string;
}

/**
 * MG-32 — remembers, for `REFRESH_REUSE_GRACE_SECONDS`, the pair issued when a refresh token
 * was rotated, so a replay of that just-rotated token (lost response, retry, double tap) gets the
 * SAME pair back. The DB only keeps SHA-256 of refresh tokens, so the plaintext successor has to
 * live somewhere short-lived: Redis with a TTL, AES-256-GCM encrypted under a key derived from
 * the OLD refresh token (`HMAC(JWT_SECRET, oldToken)`). A Redis dump alone therefore cannot
 * yield a usable token; decryption needs the replayed token itself. Redis failures degrade to
 * "no grace" (never to an error on the happy path).
 */
@Injectable()
export class RefreshGraceStore implements OnModuleDestroy {
  private readonly logger = new Logger(RefreshGraceStore.name);
  private redis: Redis | null = null;

  constructor(private readonly config: AppConfigService) {}

  get windowSeconds(): number {
    return this.config.get('REFRESH_REUSE_GRACE_SECONDS');
  }

  async put(oldToken: string, oldHash: string, pair: GracePair): Promise<void> {
    if (this.windowSeconds <= 0) return;
    try {
      await this.client().set(this.key(oldHash), this.seal(oldToken, pair), 'EX', this.windowSeconds);
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'refresh grace store write failed — replay grace unavailable');
    }
  }

  async get(oldToken: string, oldHash: string): Promise<GracePair | null> {
    try {
      const raw = await this.client().get(this.key(oldHash));
      return raw ? this.open(oldToken, raw) : null;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'refresh grace store read failed');
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis?.disconnect();
  }

  private client(): Redis {
    this.redis ??= new Redis(this.config.get('REDIS_URL'), {
      db: this.config.get('REDIS_DB'),
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
    return this.redis;
  }

  private key(oldHash: string): string {
    return `auth:refresh-grace:${oldHash}`;
  }

  private cryptoKey(oldToken: string): Buffer {
    return createHmac('sha256', this.config.get('JWT_SECRET')).update(oldToken).digest();
  }

  private seal(oldToken: string, pair: GracePair): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cryptoKey(oldToken), iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(pair), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  private open(oldToken: string, raw: string): GracePair | null {
    try {
      const buf = Buffer.from(raw, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.cryptoKey(oldToken), buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      const json = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
      return JSON.parse(json) as GracePair;
    } catch {
      return null;
    }
  }
}
