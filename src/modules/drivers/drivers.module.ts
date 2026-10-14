import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { CarrierModule } from '../carrier/carrier.module';
import { HosRecalcModule } from '../hos-recalc/hos-recalc.module';
import { ViolationsModule } from '../violations/violations.module';
import { DriverEmailChangeService } from './driver-email-change.service';
import { DriverEmailController } from './driver-email.controller';
import { DriverRosterService } from './driver-roster.service';
import { DriversController } from './drivers.controller';
import { DriversRepository } from './drivers.repository';
import { DriversService } from './drivers.service';

/** `AuthModule` (email-verify / email-change tokens, web-user re-auth) and
 * `AttachmentsModule` (B-94 document presign, shared with B-41) are all one-directional —
 * none of them imports `DriversModule` back. `StoragePort` is `@Global()` (`StorageModule`),
 * so the raw upload-PUT presign needs no import here. Mail is the `@Global()` `MailModule`
 * (`TRANSACTIONAL_MAIL`, real SMTP) — no longer `TransfersModule`'s logging-only eRODS `MAIL_PORT`. */
@Module({
  imports: [HosRecalcModule, AuthModule, AttachmentsModule, ViolationsModule, CarrierModule],
  controllers: [DriversController, DriverEmailController],
  providers: [DriversService, DriversRepository, DriverRosterService, DriverEmailChangeService],
  exports: [DriversService, DriversRepository],
})
export class DriversModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly repo: DriversRepository,
  ) {}

  /** TZ §18 — lets `AuditInterceptor` fetch `before`/`after` for `@Audit({ object: 'Driver' })`. */
  onModuleInit(): void {
    this.snapshots.register('Driver', (id) => this.repo.findById({ id }));
  }
}
