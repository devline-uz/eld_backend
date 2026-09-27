import { Module, OnModuleInit } from '@nestjs/common';
import { AuditSnapshotRegistry } from '../../common/audit/audit-snapshot.registry';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { DefectsController } from './defects.controller';
import { DefectsRepository } from './defects.repository';
import { DefectsService } from './defects.service';
import { DvirAdminController } from './dvir-admin.controller';
import { DvirAdminRepository } from './dvir-admin.repository';
import { DvirAdminService } from './dvir-admin.service';
import { DvirPdfBuilder } from './dvir-pdf.builder';
import { MaintenanceSchedulesController } from './maintenance-schedules.controller';
import { MaintenanceSchedulesRepository } from './maintenance-schedules.repository';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersRepository } from './work-orders.repository';
import { WorkOrdersService } from './work-orders.service';

/**
 * TZ §5.10 (tasks.md Phase 7) — DVIR web read/review, defect resolution, work orders and
 * maintenance scheduling. Imports `VehiclesModule` one-directionally (same pattern as
 * `VehiclesModule -> DriversModule`): the out-of-service restore rule and the maintenance
 * due-by-mileage check both need the current vehicle.
 */
@Module({
  imports: [VehiclesModule],
  controllers: [DvirAdminController, DefectsController, WorkOrdersController, MaintenanceSchedulesController],
  providers: [
    DvirAdminRepository,
    DvirAdminService,
    DvirPdfBuilder,
    DefectsRepository,
    DefectsService,
    WorkOrdersRepository,
    WorkOrdersService,
    MaintenanceSchedulesRepository,
    MaintenanceSchedulesService,
  ],
  exports: [DefectsRepository, WorkOrdersRepository, MaintenanceSchedulesRepository, MaintenanceSchedulesService],
})
export class ServiceModule implements OnModuleInit {
  constructor(
    private readonly snapshots: AuditSnapshotRegistry,
    private readonly dvirRepo: DvirAdminRepository,
    private readonly defectsRepo: DefectsRepository,
    private readonly workOrdersRepo: WorkOrdersRepository,
    private readonly schedulesRepo: MaintenanceSchedulesRepository,
  ) {}

  /** TZ §18 — snapshot loaders for `@Audit({ object: 'Dvir' | 'Defect' | 'WorkOrder' |
   * 'MaintenanceSchedule' })`. */
  onModuleInit(): void {
    this.snapshots.register('Dvir', (id) => this.dvirRepo.findById({ id }));
    this.snapshots.register('Defect', (id) => this.defectsRepo.findById({ id }));
    this.snapshots.register('WorkOrder', (id) => this.workOrdersRepo.findById({ id }));
    this.snapshots.register('MaintenanceSchedule', (id) => this.schedulesRepo.findById({ id }));
  }
}
