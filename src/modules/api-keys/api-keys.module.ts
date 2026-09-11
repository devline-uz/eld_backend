import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { ApiKeyVerifier } from '../../common/guards/api-key-verifier.port';
import { ApiKeysAuthAdapter } from './api-keys-auth.adapter';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysRepository } from './api-keys.repository';
import { ApiKeysService } from './api-keys.service';

@Module({
  controllers: [ApiKeysController],
  providers: [
    ApiKeysService,
    ApiKeysRepository,
    ApiKeysAuthAdapter,
    { provide: ApiKeyVerifier, useExisting: ApiKeysAuthAdapter },
  ],
  // `ApiKeysAuthAdapter` is exported as well, not just the `ApiKeyVerifier` token it backs:
  // AppModule re-binds the token with `{ provide: ApiKeyVerifier, useExisting: ApiKeysAuthAdapter }`
  // so its own APP_GUARD JwtAuthGuard beats CommonModule's @Global() stub, and `useExisting`
  // can only resolve a provider that is visible in AppModule's injector (bugs.md B-022).
  exports: [ApiKeysService, ApiKeysAuthAdapter, ApiKeyVerifier],
})
export class ApiKeysModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly repo: ApiKeysRepository,
  ) {}

  /** TZ §18 — lets `AuditInterceptor` fetch `before`/`after` for `@Audit({ object: 'ApiKey' })`.
   * The raw row still carries `keyHash`; `redactSecrets` strips it before the row is persisted
   * to `AuditLog` (see `common/audit/redact.ts`). */
  onModuleInit(): void {
    this.snapshots.register('ApiKey', (id) => this.repo.findById(id));
  }
}
