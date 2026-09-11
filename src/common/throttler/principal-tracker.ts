/**
 * TZ §6.5 rate limiting — tracker keys.
 *
 * The default bucket ("API 600/daq/token") stays keyed by IP, because at guard time the
 * request is not authenticated yet (`ThrottlerGuard` is registered before `JwtAuthGuard`
 * in `app.module.ts`, on purpose: an unauthenticated flood must be shed before any token
 * verification happens). The ingest bucket ("ingest 300/daq/driver") is keyed by the
 * DRIVER instead — see `decisions.md` D-051 and B-033: every `/v1/ingest/*` call comes from
 * the app with a driver JWT (§3.1, §7.1) and a whole fleet legitimately shares one depot /
 * carrier-NAT egress IP, so an IP bucket punishes the fleet for one misbehaving device.
 */

/** Minimal shape of the Express request the throttler hands to a tracker. */
export interface TrackableRequest {
  ip?: string;
  ips?: string[];
  headers?: Record<string, unknown>;
  user?: { id?: string; type?: string };
  originalUrl?: string;
  url?: string;
  path?: string;
}

const BEARER = /^Bearer\s+(.+)$/i;

/** `sub` of a JWT, read WITHOUT signature verification (see `resolveDriverTracker`). */
export function decodeTokenSubject(authorization: unknown): string | null {
  if (typeof authorization !== 'string') return null;
  const bearer = BEARER.exec(authorization.trim());
  if (!bearer) return null;
  const parts = bearer[1].split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      sub?: unknown;
      type?: unknown;
    };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/** The IP key used by the default bucket and as the ingest fallback. */
export function resolveIpTracker(req: TrackableRequest): string {
  return `ip:${req.ip ?? req.ips?.[0] ?? 'unknown'}`;
}

/**
 * `driver:<id>` when the caller carries a driver JWT, `ip:<addr>` otherwise.
 *
 * Identity is taken from `req.user` when a guard already resolved it, and otherwise from the
 * token's `sub` claim decoded (not verified) from the Authorization header. An unverified
 * claim is safe here: it can only move the caller to a DIFFERENT bucket, and a request whose
 * signature does not check out is rejected a few microseconds later by `JwtAuthGuard`, before
 * any DB or Redis work in the handler. Forging a `sub` therefore buys nothing but a 401, while
 * the global IP bucket still caps the connection.
 */
export function resolveDriverTracker(req: TrackableRequest): string {
  const contextId = req.user?.id;
  if (typeof contextId === 'string' && contextId.length > 0) return `driver:${contextId}`;
  const sub = decodeTokenSubject(req.headers?.authorization);
  return sub ? `driver:${sub}` : resolveIpTracker(req);
}

/** True for the four §7.1 ingest endpoints, whatever the configured API prefix is. */
export function isIngestRequest(req: TrackableRequest): boolean {
  const target = req.originalUrl ?? req.url ?? req.path ?? '';
  return /\/ingest\/[a-z-]+/i.test(target);
}
