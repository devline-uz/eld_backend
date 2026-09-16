import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module';
import { LiveFleetModule } from '../live/live-fleet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UnidentifiedModule } from '../unidentified/unidentified.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { ViolationsModule } from '../violations/violations.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/** Perf plan item 3 — `GET /dashboard/summary` reuses each feature module's own service; no
 * repository/query logic is duplicated here. */
@Module({
  imports: [LiveFleetModule, ViolationsModule, UnidentifiedModule, NotificationsModule, CarrierModule, VehiclesModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
