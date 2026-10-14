import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientErrorForwarder } from './client-error-forwarder';
import { ClientErrorsController } from './client-errors.controller';
import { ClientErrorsService } from './client-errors.service';

/**
 * D-158 — `POST /client-errors`. Imports AuthModule so the injected `TokenVerifier` is the real
 * `TokenService` binding, not CommonModule's NotImplemented stub (same reason as RealtimeModule).
 * No repository: nothing is stored; `ClientErrorForwarder` is the outbound adapter.
 */
@Module({
  imports: [AuthModule],
  controllers: [ClientErrorsController],
  providers: [ClientErrorsService, ClientErrorForwarder],
})
export class ClientErrorsModule {}
