import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AuthModule } from '../auth/auth.module';
import { HosRecalcModule } from '../hos-recalc/hos-recalc.module';
import { TransfersModule } from '../transfers/transfers.module';
import { DriverRosterService } from './driver-roster.service';
import { DriversController } from './drivers.controller';
import { DriversRepository } from './drivers.repository';
import { DriversService } from './drivers.service';

/** `AuthModule` (email-verify tokens), `TransfersModule` (its `MAIL_PORT`), and
 * `AttachmentsModule` (B-94 document presign, shared with B-41) are all one-directional —
 * none of them imports `DriversModule` back. `StoragePort` is `@Global()` (`StorageModule`),
 * so the raw upload-PUT presign needs no import here. */
@Module({
  imports: [HosRecalcModule, AuthModule, TransfersModule, AttachmentsModule],
  controllers: [DriversController],
  providers: [DriversService, DriversRepository, DriverRosterService],
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
