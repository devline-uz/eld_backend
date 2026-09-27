import { Module } from '@nestjs/common';
import { TokenVerifier } from '../../common/guards/token-verifier.port';
import { AttachmentsModule } from '../attachments/attachments.module';
import { CarrierModule } from '../carrier/carrier.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DriverAuthRepository } from './repositories/driver-auth.repository';
import { DriverSessionRepository } from './repositories/driver-session.repository';
import { SessionRepository } from './repositories/session.repository';
import { UserAuthRepository } from './repositories/user-auth.repository';
import { TokenService } from './token.service';

/**
 * TZ §6 — real binding for `TokenVerifier` (replaces `NotImplementedTokenVerifier` from
 * `CommonModule`). `CommonModule` is `@Global()`, but Nest resolves the *last* provider
 * registered for a token across the module graph, so re-providing it here — and importing
 * AuthModule from AppModule — is sufficient; `JwtAuthGuard` never changes.
 *
 * `CarrierModule` — B-34 `GET /auth/me` adds `carrierName`/`homeTerminalTimezone`; a
 * one-directional dependency (`CarrierModule` never imports `AuthModule` back).
 * `AttachmentsModule` — B-34/B-51 `avatarUrl` reuses the reusable presign helper
 * (`AttachmentsService.presignKey`, §20 B-41) instead of `STORAGE_PORT` directly.
 */
@Module({
  imports: [CarrierModule, AttachmentsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    { provide: TokenVerifier, useExisting: TokenService },
    UserAuthRepository,
    DriverAuthRepository,
    SessionRepository,
    DriverSessionRepository,
  ],
  exports: [TokenService, AuthService, TokenVerifier],
})
export class AuthModule {}
