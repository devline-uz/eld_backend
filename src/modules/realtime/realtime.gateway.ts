import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { TokenVerifier } from '../../common/guards/token-verifier.port';
import type { ContextUser } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { RealtimeRoomAuthorizer } from './room-authorizer';

interface AuthedSocket extends Socket {
  data: { user?: ContextUser };
}

/** Rooms a connected client may join, per TZ §12.4. Shape only — who may join which room is
 * decided by {@link RealtimeRoomAuthorizer}: `driver:{id}`/`user:{id}` belong to that
 * principal alone, `conversation:{id}` needs participation, `vehicle:{id}` needs the driver's
 * own unit, and the `fleet`/`violations` broadcast rooms are back-office only. */
const ALLOWED_ROOM_PATTERN = /^(fleet|violations|vehicle:[\w-]+|driver:[\w-]+|user:[\w-]+|conversation:[\w-]+)$/;

/**
 * TZ §12 — real-time transport for dispatch/safety/HOS/messaging updates.
 *
 * Transport: Socket.IO (TZ §12.1). Auth: the same access token used for REST, passed as
 * `auth.token` on the handshake ONLY (§12.2) — never `?token=`, because a query string is
 * persisted by proxies, CDNs and access logs — verified through the same
 * `TokenVerifier` port `JwtAuthGuard` uses, so there is exactly one JWT verification path.
 * Every `EventBusService.publish('realtime.push', { room, event, payload })` call made
 * anywhere in the API (ingest, trips, safety-detect, messaging, alerts, ...) is relayed
 * here — this gateway does not know about individual features, only about rooms.
 */
@WebSocketGateway({
  // Same strict allowlist the REST app uses (`CORS_ORIGINS`); `origin: true` reflected any
  // Origin back with credentials, which is a wildcard in all but name.
  cors: { origin: realtimeCorsOrigins(), credentials: true },
  namespace: '/realtime',
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);
  private unsubscribe?: () => void;

  constructor(
    private readonly tokens: TokenVerifier,
    private readonly events: EventBusService,
    private readonly rooms: RealtimeRoomAuthorizer,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.events.on<{ room: string; event: string; payload: unknown }>(
      'realtime.push',
      async ({ payload }) => {
        this.server?.to(payload.room).emit(payload.event, payload.payload);
      },
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async handleConnection(socket: AuthedSocket): Promise<void> {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) throw new Error('Missing token');
      const user = await this.tokens.verifyAccessToken(token);
      socket.data.user = user;
      // §12.4 — every client auto-joins its own identity room so `driver:{id}`/`user:{id}`
      // pushes (HOS updates, alerts, messages) reach it without an explicit subscribe call.
      const ownRoom = user.type === 'driver' ? `driver:${user.id}` : `user:${user.id}`;
      await socket.join(ownRoom);
    } catch (err) {
      this.logger.warn({ err }, 'WebSocket auth failed — disconnecting.');
      socket.disconnect(true);
    }
  }

  handleDisconnect(): void {
    // Socket.IO cleans up room membership on disconnect automatically.
  }

  @SubscribeMessage('subscribe')
  async onSubscribe(@ConnectedSocket() socket: AuthedSocket, @MessageBody() room: string): Promise<{ ok: boolean }> {
    const user = socket.data.user;
    // A socket whose handshake never completed verification has no identity and joins nothing.
    if (!user) return { ok: false };
    if (typeof room !== 'string' || !ALLOWED_ROOM_PATTERN.test(room)) return { ok: false };
    if (!(await this.rooms.mayJoin(room, user))) return { ok: false };
    await socket.join(room);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  async onUnsubscribe(@ConnectedSocket() socket: AuthedSocket, @MessageBody() room: string): Promise<{ ok: boolean }> {
    await socket.leave(room);
    return { ok: true };
  }
}

/** `CORS_ORIGINS` is read directly here because `@WebSocketGateway` metadata is evaluated at
 * class-decoration time, before the Nest injector exists. Falls back to "no origin allowed"
 * rather than "any origin" if the variable is missing. */
function realtimeCorsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
