import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeRoomAuthorizer } from './room-authorizer';

/** TZ §12 — WebSocket gateway wiring for real-time dispatch/safety/HOS/messaging updates. */
@Module({
  providers: [RealtimeGateway, RealtimeRoomAuthorizer],
})
export class RealtimeModule {}
