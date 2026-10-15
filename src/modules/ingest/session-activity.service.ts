import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor, Optional } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import { DriverSessionRepository } from '../auth/repositories/driver-session.repository';

/** D-161 — only motion this fresh counts; an offline backlog uploaded later must not lock out logins. */
export const MOTION_FRESHNESS_MS = 5 * 60_000;
/** D-161 — `lastMotionAt` is rewritten at most this often per session (login window is 120 s). */
export const MOTION_WRITE_THROTTLE_MS = 30_000;
/** D-161 — `lastSeenAt` is rewritten at most this often per session. */
export const SEEN_WRITE_THROTTLE_MS = 60_000;
/** Bound on the per-process caches; cleared wholesale when exceeded (worst case: one extra write). */
const CACHE_LIMIT = 10_000;

/** A sample that may show the vehicle moving: `at` is the device-side time of the sample. */
export interface MotionSample {
  at: Date;
  moving: boolean;
}

/**
 * Single-device rule (MD-195, D-159/D-161) — feeds `DriverSession.lastMotionAt` (blocks a login
 * from another device for 120 s) and `DriverSession.lastSeenAt` (shown as `replacedDevice.lastSeenAt`)
 * from authenticated driver traffic. Both writes are throttled through a per-process, per-sid cache
 * and are strictly best-effort: an error is logged, never thrown into the request.
 */
@Injectable()
export class SessionActivityService {
  private readonly logger = new Logger(SessionActivityService.name);
  private readonly motionWritten = new Map<string, number>();
  private readonly seenWritten = new Map<string, number>();

  constructor(@Optional() private readonly sessions?: DriverSessionRepository) {}

  /**
   * Records the newest fresh moving sample of an accepted ingest batch. Samples older than
   * {@link MOTION_FRESHNESS_MS} are ignored; a future timestamp is capped at `now`.
   */
  async noteMotion(actor: ContextUser | undefined, samples: Iterable<MotionSample>, now: Date = new Date()): Promise<void> {
    if (!this.sessions || actor?.type !== 'driver' || !actor.sessionId) return;
    const nowMs = now.getTime();
    let latest = -Infinity;
    for (const s of samples) {
      if (!s.moving) continue;
      const t = Math.min(s.at.getTime(), nowMs);
      if (Number.isFinite(t) && nowMs - t <= MOTION_FRESHNESS_MS && t > latest) latest = t;
    }
    if (latest === -Infinity) return;
    const sid = actor.sessionId;
    const prev = this.motionWritten.get(sid);
    if (prev !== undefined && latest - prev < MOTION_WRITE_THROTTLE_MS) return;
    remember(this.motionWritten, sid, latest);
    try {
      await this.sessions.markMotion(sid, new Date(latest));
    } catch (err) {
      this.motionWritten.delete(sid);
      this.logger.warn({ err, sid }, 'Failed to record session motion');
    }
  }

  /** Touches `lastSeenAt` for a driver session at most once per {@link SEEN_WRITE_THROTTLE_MS}. */
  async noteSeen(actor: ContextUser | undefined, now: Date = new Date()): Promise<void> {
    if (!this.sessions || actor?.type !== 'driver' || !actor.sessionId) return;
    const sid = actor.sessionId;
    const nowMs = now.getTime();
    const prev = this.seenWritten.get(sid);
    if (prev !== undefined && nowMs - prev < SEEN_WRITE_THROTTLE_MS) return;
    remember(this.seenWritten, sid, nowMs);
    try {
      await this.sessions.touchLastSeen(sid, now);
    } catch (err) {
      this.seenWritten.delete(sid);
      this.logger.warn({ err, sid }, 'Failed to touch session lastSeenAt');
    }
  }
}

function remember(cache: Map<string, number>, key: string, value: number): void {
  if (cache.size >= CACHE_LIMIT && !cache.has(key)) cache.clear();
  cache.set(key, value);
}

/**
 * D-161 — the central hook for `lastSeenAt`: every request that passed auth with a driver token
 * touches its session (throttled, fire-and-forget — never delays or fails the request).
 */
@Injectable()
export class DriverActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: SessionActivityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const actor = RequestContext.user ?? context.switchToHttp().getRequest<{ user?: ContextUser }>().user;
      if (actor?.type === 'driver' && actor.sessionId) void this.activity.noteSeen(actor);
    }
    return next.handle();
  }
}
