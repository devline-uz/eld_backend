import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { DevicesModule } from '../devices/devices.module';
import { MessagingModule } from '../messaging/messaging.module';
import { MobileSupportController } from './mobile-support.controller';
import { SupportController } from './support.controller';
import { SupportRepository } from './support.repository';
import { SupportService } from './support.service';
import { TicketAttachmentsRepository } from './ticket-attachments.repository';
import { TicketAttachmentsService } from './ticket-attachments.service';

/** §20 B-90 imports `MessagingModule` to reuse `Conversation`/`Message` + the socket room
 * plumbing for support chat rather than a bespoke chat model. §20 B-91 imports `DevicesModule`
 * for the device-diagnostics ticket attachment. */
@Module({
  imports: [MessagingModule, DevicesModule],
  controllers: [SupportController, MobileSupportController],
  providers: [SupportService, SupportRepository, TicketAttachmentsService, TicketAttachmentsRepository],
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
