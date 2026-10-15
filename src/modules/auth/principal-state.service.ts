import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { withRetiredKeysCleared, type PermissionMatrix } from '../../common/decorators/permission.types';
import { EventBusService } from '../../core/events/event-bus.service';
import { RealtimePubSubService } from '../../core/events/realtime-pubsub.service';
import { DriverAuthRepository } from './repositories/driver-auth.repository';
import { DriverSessionRepository, type ReplacementInfo } from './repositories/driver-session.repository';
import { SessionRepository } from './repositories/session.repository';
import { UserAuthRepository } from './repositories/user-auth.repository';

/** How long a resolved user/session state is reused before the DB is asked again. Ordinary
 * changes (e.g. a permission grant) may lag this long on other API replicas; critical ones
 * (disable, delete, revoke, password reset, token reuse, downgrade) go through `invalidateUser` /
 * `invalidateDriver`, which evict at once on this process and, via the Redis relay, on every replica. */
export const PRINCIPAL_STATE_TTL_MS = 15_000;
/** Upper bound on cached entries, so a flood of distinct tokens cannot grow the map forever. */
const MAX_ENTRIES = 5_000;

/** Realtime event pushed to `user:{id}`; `RealtimeGateway` disconnects the matching sockets. */
export const AUTH_REVOKED_EVENT = 'auth.revoked';

/** MD-195 — relayed to `driver:{id}`: drop this driver's cached per-session liveness (sockets stay). */
export const DRIVER_SESSION_EVICT_EVENT = 'auth.driver-session-evict';

/** `driver:{id}` / `user:{id}` — the identity rooms an `auth.revoked` relay message may name. */
const IDENTITY_ROOM = /^(user|driver):([\w-]+)$/;

export interface LiveUserState {
  roleKey: string;
  permissions: PermissionMatrix;
}

/**
 * CODE-012 — an access token is no longer trusted on its own for its 15-minute life. Every
 * back-office token is re-checked against the DB (cached briefly): the user must still be ACTIVE,
 * the `sid` session (or the session it was rotated into) must not be revoked/expired, and the
 * role + permissions come from the DB, not from the token, so a role change or a role-permission
 * edit applies without a new login.
 */
@Injectable()
export class PrincipalStateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrincipalStateService.name);
  private readonly cache = new Map<string, { at: number; state: LiveUserState | null }>();
  private readonly driverCache = new Map<string, { at: number; live: boolean }>();
  private unsubscribeRelay?: () => void;

  constructor(
    private readonly users: UserAuthRepository,
    private readonly sessions: SessionRepository,
    private readonly events: EventBusService,
    @Optional() private readonly drivers?: DriverAuthRepository,
    @Optional() private readonly driverSessions?: DriverSessionRepository,
    /** Cross-replica eviction: every `auth.revoked` relayed through Redis (published by any
     * replica or the worker) also drops this replica's cached state for that principal. */
    @Optional() private readonly relay?: RealtimePubSubService,
  ) {}

  onModuleInit(): void {
    this.unsubscribeRelay = this.relay?.onRelayed((message) => {
      if (message.event !== AUTH_REVOKED_EVENT && message.event !== DRIVER_SESSION_EVICT_EVENT) return;
      const rooms = Array.isArray(message.room) ? message.room : [message.room];
      for (const room of rooms) {
        const match = IDENTITY_ROOM.exec(room);
        if (!match) continue;
        if (match[1] === 'user') this.evictUser(match[2]);
        else this.evictDriver(match[2]);
      }
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeRelay?.();
  }

  /** `null` = the token must be refused (user gone/disabled, session revoked or expired). */
  async resolveUser(userId: string, sessionId?: string): Promise<LiveUserState | null> {
    const key = `${userId}|${sessionId ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < PRINCIPAL_STATE_TTL_MS) return hit.state;

    const [user, sessionLive] = await Promise.all([
      this.users.findByIdWithRole(userId),
      sessionId ? this.sessions.isLineageLive(sessionId, userId) : Promise.resolve(true),
    ]);
    const state: LiveUserState | null =
      user && user.status === 'ACTIVE' && sessionLive
        ? { roleKey: user.role.key, permissions: withRetiredKeysCleared(user.role.permissions as PermissionMatrix) }
        : null;

    if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: Date.now(), state });
    return state;
  }

  /**
   * Driver (mobile) access tokens are honoured only while the driver is ACTIVE, not deleted, and
   * the token's own session (`sid`) lineage is live — MD-195: a takeover from another device ends
   * only that device's family. Tokens without `sid` keep the old "any live app session" rule.
   * Disabling the driver (which revokes every session) or "log out everywhere" ends them at once.
   */
  async resolveDriver(driverId: string, sessionId?: string): Promise<boolean> {
    if (!this.drivers || !this.driverSessions) return true;
    const key = `${driverId}|${sessionId ?? ''}`;
    const hit = this.driverCache.get(key);
    if (hit && Date.now() - hit.at < PRINCIPAL_STATE_TTL_MS) return hit.live;
    const [driver, sessionLive] = await Promise.all([
      this.drivers.findById(driverId),
      sessionId
        ? this.driverSessions.lineageState(driverId, sessionId).then((s) => s.live)
        : this.driverSessions.hasLiveSession(driverId),
    ]);
    const live = !!driver && driver.status === 'ACTIVE' && !driver.deletedAt && sessionLive;
    // Only a pass is cached: a refusal must not outlive a fresh login or a re-activation (which
    // any replica may serve), and a cut-off driver's retries are rare enough to hit the DB.
    if (!live) return false;
    if (this.driverCache.size >= MAX_ENTRIES) this.driverCache.clear();
    this.driverCache.set(key, { at: Date.now(), live });
    return live;
  }

  /** MD-195 — why a refused driver token was refused: a takeover (never cached), or null. */
  async driverReplacement(driverId: string, sessionId: string | undefined): Promise<ReplacementInfo | null> {
    if (!sessionId || !this.driverSessions) return null;
    return this.driverSessions.replacementFor(driverId, sessionId);
  }

  /**
   * MD-195 — a takeover ended some of this driver's sessions: forget cached liveness here and on
   * every replica, WITHOUT dropping sockets (the new device's socket must stay connected).
   */
  async evictDriverSessions(driverId: string): Promise<void> {
    this.evictDriver(driverId);
    try {
      await this.events.publish('realtime.push', { room: `driver:${driverId}`, event: DRIVER_SESSION_EVICT_EVENT, payload: {} });
    } catch (err) {
      this.logger.error({ err, driverId }, 'Failed to broadcast driver session eviction; other replicas catch up within the cache TTL');
    }
  }

  private evictDriver(driverId: string): void {
    for (const key of this.driverCache.keys()) {
      if (key.startsWith(`${driverId}|`)) this.driverCache.delete(key);
    }
  }

  /** Critical driver change (disabled, terminated, deleted, sessions revoked): evict here, on
   * every other replica (relay) and drop the driver's sockets. Never throws. */
  async invalidateDriver(driverId: string): Promise<void> {
    this.evictDriver(driverId);
    await this.publishRevoked(`driver:${driverId}`);
  }

  /**
   * Forget the cached state of a user and drop all their live sockets. A socket's token may name
   * an older (rotated) session id, so sockets are not matched by session: every one reconnects and
   * is re-authorized, and only those whose session is still live get back in.
   */
  async invalidateUser(userId: string): Promise<void> {
    this.evictUser(userId);
    await this.publishRevoked(`user:${userId}`);
  }

  /** A role's permissions changed: drop every cached state and the sockets of its holders. */
  async invalidateUsers(userIds: readonly string[]): Promise<void> {
    this.cache.clear();
    await Promise.all(userIds.map((id) => this.invalidateUser(id)));
  }

  private evictUser(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}|`)) this.cache.delete(key);
    }
  }

  /** Local eviction already happened; a Redis outage only delays other replicas (≤ TTL). */
  private async publishRevoked(room: string): Promise<void> {
    try {
      await this.events.publish('realtime.push', { room, event: AUTH_REVOKED_EVENT, payload: {} });
    } catch (err) {
      this.logger.error({ err, room }, 'Failed to broadcast auth.revoked; other replicas catch up within the cache TTL');
    }
  }
}
