import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MessagingModule } from '../messaging/messaging.module';
import { DeviceHealthController } from './device-health.controller';
import { DeviceHealthRepository } from './device-health.repository';
import { DeviceHealthService } from './device-health.service';
import { DvirPhotosRepository } from './dvir-photos.repository';
import { HosRecalcModule } from '../hos-recalc/hos-recalc.module';
import { LogsModule } from '../logs/logs.module';
import { MobileAppConfigController } from './mobile-app-config.controller';
import { MobileAppConfigService } from './mobile-app-config.service';
import { MobileBootstrapController } from './mobile-bootstrap.controller';
import { MobileBootstrapService } from './mobile-bootstrap.service';
import { MobileCoDriverController } from './mobile-codriver.controller';
import { MobileCoDriverService } from './mobile-codriver.service';
import { MobileCatalogController } from './mobile-catalog.controller';
import { MobileCatalogRepository } from './mobile-catalog.repository';
import { MobileSavedSignatureService } from './mobile-saved-signature.service';
import { MobileContactsController } from './mobile-contacts.controller';
import { MobileContactsService } from './mobile-contacts.service';
import { MobileDutyStatusController } from './mobile-duty-status.controller';
import { MobileDvirController } from './mobile-dvir.controller';
import { MobileDvirHistoryController } from './mobile-dvir-history.controller';
import { MobileDvirHistoryService } from './mobile-dvir-history.service';
import { MobileDvirService } from './mobile-dvir.service';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileMaintenanceController } from './mobile-maintenance.controller';
import { MobileMaintenanceRepository } from './mobile-maintenance.repository';
import { MobileMaintenanceService } from './mobile-maintenance.service';
import { MobileMessagingController } from './mobile-messaging.controller';
import { MobileMessagingRepository } from './mobile-messaging.repository';
import { MobileMessagingService } from './mobile-messaging.service';
import { MobileSyncController } from './mobile-sync.controller';
import { MobileSyncService } from './mobile-sync.service';
import { MobileTrailersController, MobileTripController } from './mobile-trip.controller';
import { MobileTripService } from './mobile-trip.service';
import { MobileVehicleController } from './mobile-vehicle.controller';
import { MobileVehicleService } from './mobile-vehicle.service';
import { MobileRepository } from './mobile.repository';
import { PushTokensController } from './push-tokens.controller';
import { PushTokensRepository } from './push-tokens.repository';
import { PushTokensService } from './push-tokens.service';
import { SignatureService } from './signature.service';

/**
 * TZ §6 (tasks.md Phase 6) — Mobile API: bootstrap, offline sync, duty-status, DVIR +
 * signature. `HosStateModule` (§8.6 point 5, `POST /mobile/hos-state`) is registered
 * separately in `app.module.ts` — it predates this module and is left untouched.
 *
 * Phase 6b (mobile/tz.md §21.1, `mobile/decisions.md` MD-001) additions — MB-2/MB-3/MB-5/
 * MB-10/MB-14 — each live in their own controller/service file; `MobileFleetOpsRepository`
 * is their shared DB-access point, kept separate from `MobileRepository` on purpose.
 */
@Module({
  imports: [HosRecalcModule, LogsModule, AuditModule, AuthModule, MessagingModule],
  controllers: [
    MobileAppConfigController,
    MobileBootstrapController,
    MobileSyncController,
    MobileDutyStatusController,
    MobileDvirController,
    MobileVehicleController,
    MobileCoDriverController,
    MobileTripController,
    MobileTrailersController,
    MobileDvirHistoryController,
    MobileCatalogController,
    MobileContactsController,
    PushTokensController,
    DeviceHealthController,
    MobileMessagingController,
    MobileMaintenanceController,
  ],
  providers: [
    MobileRepository,
    MobileAppConfigService,
    MobileBootstrapService,
    MobileSyncService,
    MobileDvirService,
    SignatureService,
    DvirPhotosRepository,
    MobileCatalogRepository,
    MobileSavedSignatureService,
    MobileFleetOpsRepository,
    MobileVehicleService,
    MobileCoDriverService,
    MobileTripService,
    MobileDvirHistoryService,
    MobileContactsService,
    // MB-1 (push tokens), MB-7 (device health), MB-15 (driver-facing messaging) — Phase 6b.
    PushTokensRepository,
    PushTokensService,
    DeviceHealthRepository,
    DeviceHealthService,
    MobileMessagingRepository,
    MobileMessagingService,
    // M-38..M-42 (wave 4) — driver maintenance tasks + invoice submission.
    MobileMaintenanceRepository,
    MobileMaintenanceService,
  ],
  exports: [MobileRepository, SignatureService, MobileFleetOpsRepository],
})
export class MobileModule {}
