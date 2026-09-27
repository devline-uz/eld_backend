import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/config.service';
import { EventBusService } from './event-bus.service';

/** B-097 — Redis pub/sub channels are server-wide: `REDIS_DB` does NOT scope them (unlike
 * keys). Without a namespace, every environment/test run sharing one Redis server relayed its
 * pushes into every other environment's sockets. Namespaced like BullMQ (`QUEUE_PREFIX`) plus
 * the logical DB, so two deployments are isolated exactly as far as their queues are. */
export function realtimeChannel(queuePrefix: string, redisDb: number): string {
  return `${queuePrefix}:db${redisDb}:realtime:push`;
}

/** Same room grammar `RealtimeGateway` accepts from clients (TZ §12.4). */
const RELAY_ROOM_PATTERN = /^(fleet|violations|vehicle:[\w-]+|driver:[\w-]+|user:[\w-]+|conversation:[\w-]+)$/;
const RELAY_EVENT_PATTERN = /^[\w.:-]{1,100}$/;

/** B-097 — a relayed message is untrusted bytes off the network, not an in-process object:
 * anything not shaped exactly like a `realtime.push` payload is dropped, never emitted. */
export function isRelayPayload(value: unknown): value is RealtimePushPayload {
  if (!value || typeof value !== 'object') return false;
  const { room, event } = value as Record<string, unknown>;
  return typeof room === 'string' && RELAY_ROOM_PATTERN.test(room) && typeof event === 'string' && RELAY_EVENT_PATTERN.test(event);
}

export interface RealtimePushPayload {
  room: string;
  event: string;
  payload: unknown;
}

/**
 * B-49 — bridges the in-process `EventBusService` `realtime.push` domain event across the
 * API/worker process boundary (TZ §3.3, §12). `EventBusService` only calls handlers registered
 * in the SAME Node process, so a `report.processor` (worker container) publish of
 * `realtime.push` never reached `RealtimeGateway` (API container) — the socket event was
 * silently dropped. This service:
 *  - subscribes locally to `realtime.push` and re-publishes it on a Redis pub/sub channel
 *    (runs in both processes — whichever one published it forwards it out);
 *  - subscribes to that same Redis channel and hands relayed messages to `onRelayed`
 *    listeners (only `RealtimeGateway`, which lives in the API process, registers one).
 * A local publish is not looped back to itself via `onRelayed` — the socket emit only ever
 * happens from the Redis-delivered message, so API-local callers (trips, messaging, ingest)
 * and worker-only callers (report, alert, safety-detect) are relayed identically.
 */
@Injectable()
export class RealtimePubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimePubSubService.name);
  private publisher?: Redis;
  private subscriber?: Redis;
  private unsubscribeLocal?: () => void;
  private readonly relayHandlers = new Set<(payload: RealtimePushPayload) => void>();
  private channel = '';

  constructor(
    private readonly config: AppConfigService,
    private readonly events: EventBusService,
  ) {}

  onModuleInit(): void {
    const url = this.config.get('REDIS_URL');
    const db = this.config.get('REDIS_DB');
    this.channel = realtimeChannel(this.config.get('QUEUE_PREFIX'), db);
    const channel = this.channel;
    this.publisher = new Redis(url, { db });
    this.subscriber = new Redis(url, { db });

    this.unsubscribeLocal = this.events.on<RealtimePushPayload>('realtime.push', async ({ payload }) => {
      try {
        await this.publisher?.publish(channel, JSON.stringify(payload));
      } catch (err) {
        this.logger.error({ err }, 'Failed to publish realtime.push to Redis');
      }
    });

    this.subscriber.on('message', (from: string, message: string) => {
      if (from !== channel) return;
      try {
        const payload = JSON.parse(message) as unknown;
        if (!isRelayPayload(payload)) {
          this.logger.warn({ channel }, 'Dropped malformed relayed realtime.push message');
          return;
        }
        for (const handler of this.relayHandlers) handler(payload);
      } catch (err) {
        this.logger.error({ err }, 'Failed to parse relayed realtime.push message');
      }
    });

    this.subscriber.subscribe(channel).catch((err: unknown) => {
      this.logger.error({ err }, 'Failed to subscribe to realtime:push channel');
    });
  }

  /** Registered by `RealtimeGateway` (API process only) to receive cross-process pushes. */
  onRelayed(handler: (payload: RealtimePushPayload) => void): () => void {
    this.relayHandlers.add(handler);
    return () => this.relayHandlers.delete(handler);
  }

  async onModuleDestroy(): Promise<void> {
    this.unsubscribeLocal?.();
    this.relayHandlers.clear();
    await this.subscriber?.quit().catch(() => undefined);
    await this.publisher?.quit().catch(() => undefined);
  }
}
