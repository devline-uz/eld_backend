import type { INestApplication } from '@nestjs/common';
import type { AppEnv } from './env.schema';

/** The slice of an Express app this needs (kept structural so unit tests can pass `express()`). */
export interface TrustProxyTarget {
  set(setting: string, value: unknown): unknown;
}

/**
 * CODE-004 — Express `trust proxy` from the validated `TRUST_PROXY` (default `loopback`).
 *
 * Behind Caddy (`docker/caddy/Caddyfile` -> localhost:3000) every socket peer is 127.0.0.1, so
 * without this `req.ip` was the proxy for every client: one client's failed logins filled the
 * shared `ip:127.0.0.1` throttler bucket (`principal-tracker.ts`) and the audit log / sessions
 * recorded 127.0.0.1 (`request-context.middleware.ts`, `auth.service.ts`). With an address list,
 * Express walks `X-Forwarded-For` right-to-left only while the hop is a listed proxy, so a client
 * that connects directly (non-listed socket address) gets its socket address, never the header.
 */
export function applyTrustProxy(target: TrustProxyTarget, value: AppEnv['TRUST_PROXY']): void {
  target.set('trust proxy', value);
}

/** Nest wrapper: the platform is always Express here (`@nestjs/platform-express`). */
export function configureTrustProxy(app: INestApplication, value: AppEnv['TRUST_PROXY']): void {
  const instance: unknown = app.getHttpAdapter().getInstance();
  applyTrustProxy(instance as TrustProxyTarget, value);
}
