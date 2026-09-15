import { Module } from '@nestjs/common';
import { TokenVerifier } from '../../common/guards/token-verifier.port';
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
 */
@Module({
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
