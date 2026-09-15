import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeRoomAuthorizer } from './room-authorizer';

/**
 * TZ §12 — WebSocket gateway wiring for real-time dispatch/safety/HOS/messaging updates.
 *
 * Imports AuthModule so `RealtimeGateway`'s injected `TokenVerifier` resolves to the same
 * real binding (`{ provide: TokenVerifier, useExisting: TokenService }`) that `JwtAuthGuard`
 * uses on REST — modules resolve providers from their own injector plus what they import,
 * not from AppModule's injector, so without this import the gateway fell back to
 * `CommonModule`'s `NotImplementedTokenVerifier` stub and rejected every handshake (B-0NN).
 */
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RealtimeRoomAuthorizer],
})
export class RealtimeModule {}
