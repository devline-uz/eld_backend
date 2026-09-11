import { Module, OnModuleInit } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsRepository } from './integrations.repository';
import { IntegrationsService } from './integrations.service';
import { IntegrationCipherService } from './lib/integration-cipher.service';

// `CommonModule` is `@Global()`, but that only makes its providers ambient once the module
// has been imported somewhere in the current application tree. `WorkersModule` (worker.ts)
// imports `IntegrationsModule` directly, without ever importing `CommonModule` — unlike
// AppModule (API), it has no controllers/guards. Import it explicitly here so
// `AuditSnapshotRegistry` resolves in both compositions (see B-013).
@Module({
  imports: [CommonModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, IntegrationsRepository, IntegrationCipherService],
  exports: [IntegrationsService, IntegrationCipherService],
})
export class IntegrationsModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly service: IntegrationsService,
  ) {}

  /** TZ §18 — `before`/`after` for `@Audit({ object: 'Integration' })`. Uses the redacted
   * view (never the raw row) so an encrypted-secret ciphertext never reaches `AuditLog`. */
  onModuleInit(): void {
    this.snapshots.register('Integration', (provider) => this.service.getRedactedSnapshot(provider));
  }
}
