import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { SupportController } from './support.controller';
import { SupportRepository } from './support.repository';
import { SupportService } from './support.service';

@Module({
  controllers: [SupportController],
  providers: [SupportService, SupportRepository],
  exports: [SupportService, SupportRepository],
})
export class SupportModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly repo: SupportRepository,
  ) {}

  /** TZ §18 — lets `AuditInterceptor` fetch `before`/`after` for `@Audit({ object: 'SupportTicket' })`. */
  onModuleInit(): void {
    this.snapshots.register('SupportTicket', (id) => this.repo.findById({ id }));
  }
}
