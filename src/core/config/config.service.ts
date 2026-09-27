import { Injectable } from '@nestjs/common';
import { AppEnv } from './env.schema';

/** Typed, validated access to the environment. Nothing reads process.env directly. */
@Injectable()
export class AppConfigService {
  constructor(private readonly env: AppEnv) {}

  get<K extends keyof AppEnv>(key: K): AppEnv[K] {
    return this.env[key];
  }

  get all(): Readonly<AppEnv> {
    return this.env;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  /** B-093 — whether a one-time secret may be echoed in an API response (dev convenience).
   * Never in production, and elsewhere only when `DEV_ECHO_SECRETS=true`. */
  get echoOneTimeSecrets(): boolean {
    return !this.isProduction && this.env.DEV_ECHO_SECRETS;
  }

  get corsOrigins(): string[] {
    return this.env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }
}
