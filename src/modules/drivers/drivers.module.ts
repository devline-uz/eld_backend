import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { HosRecalcModule } from '../hos-recalc/hos-recalc.module';
import { DriverRosterService } from './driver-roster.service';
import { DriversController } from './drivers.controller';
import { DriversRepository } from './drivers.repository';
import { DriversService } from './drivers.service';

@Module({
  imports: [HosRecalcModule],
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
