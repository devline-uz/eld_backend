import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionGuard } from './common/guards/permission.guard';
import { TwoFactorSetupGuard } from './common/guards/two-factor-setup.guard';
import { TokenVerifier } from './common/guards/token-verifier.port';
import { ApiKeyVerifier } from './common/guards/api-key-verifier.port';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { AppConfigModule } from './core/config/config.module';
import { AppConfigService } from './core/config/config.service';
import { EventsModule } from './core/events/events.module';
import { FirebaseModule } from './core/firebase/firebase.module';
import { AppLoggerModule } from './core/logger/logger.module';
import { PrismaModule } from './core/prisma/prisma.module';
import { QueueModule } from './core/queue/queue.module';
import { StorageModule } from './core/storage/storage.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsInterceptor } from './modules/health/metrics.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { TokenService } from './modules/auth/token.service';
import { RolesModule } from './modules/roles/roles.module';
import { UsersModule } from './modules/users/users.module';
import { AuditModule } from './modules/audit/audit.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { ApiKeysAuthAdapter } from './modules/api-keys/api-keys-auth.adapter';
import { DriversModule } from './modules/drivers/drivers.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { DevicesModule } from './modules/devices/devices.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { HosStateModule } from './modules/hos-state/hos-state.module';
import { TelemetryModule } from './modules/telemetry/telemetry.module';
import { CarrierModule } from './modules/carrier/carrier.module';
import { SupportModule } from './modules/support/support.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { LogsModule } from './modules/logs/logs.module';
import { UnidentifiedModule } from './modules/unidentified/unidentified.module';
import { TransfersModule } from './modules/transfers/transfers.module';
import { MobileModule } from './modules/mobile/mobile.module';
import { TripsModule } from './modules/trips/trips.module';
import { SafetyModule } from './modules/safety/safety.module';
import { GeofencesModule } from './modules/geofences/geofences.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { DtcModule } from './modules/dtc/dtc.module';
import { ServiceModule } from './modules/service/service.module';

/**
 * Module tree per TZ §3.4. Feature modules are added by their owning phase.
 *
 * AppConfigModule is imported first on purpose: it validates the environment and runs
 * the non-disableable db-guard (TZ §22.3.4) before Prisma can open a connection.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    FirebaseModule,
    EventsModule,
    CommonModule,
    HealthModule,
    AuthModule,
    RolesModule,
    UsersModule,
    AuditModule,
    ApiKeysModule,
    // Phase 2 — Fleet (TZ §5.3, §5.4, §5.10). DriversModule first: VehiclesModule depends
    // on it (assign/unassign-driver); DevicesModule depends on VehiclesModule (pairing).
    DriversModule,
    VehiclesModule,
    DevicesModule,
    // Phase 3 — Ingest (TZ §7). TelemetryModule holds the Virtual Dashboard write path that
    // `/ingest/telemetry` feeds; IngestModule imports it. DtcModule (Phase 7, TZ §5.7) is
    // imported here too since `GET /vehicles/:id/dtc` is its own route tree.
    DtcModule,
    TelemetryModule,
    IngestModule,
    // Phase 5 — RODS (TZ §9). Daily logs, the §395.30 edit flow, driver self-edits,
    // certification and unidentified-driving assignment. LogsModule first: UnidentifiedModule
    // depends on its append-only `RodsEventWriter`.
    LogsModule,
    UnidentifiedModule,
    // Phase 9 — eRODS (TZ §10). Appendix A output file generation, validation, download and
    // the domain-restricted, encrypted email transfer. TEST mode by default (§10.1).
    TransfersModule,
    // Phase 4b — HOS state exchange (TZ §8.6): `POST /mobile/hos-state` plus the drift
    // comparison the nightly worker job drives. Owned by eld-hos-engine.
    HosStateModule,
    // Phase 6 — Mobile API (TZ §11.8, §13). Bootstrap, offline sync, duty-status, DVIR +
    // signature. Imported after LogsModule/HosStateModule, which it depends on.
    MobileModule,
    // Phase 7 — DVIR and Service (TZ §5.10). Web-side DVIR/defect read+resolve, work orders,
    // maintenance schedules. Owned by eld-fleet-ops.
    ServiceModule,
    // Phase 11 — Settings (TZ §5.1, §5.10, §11.7). Carrier is the single-row profile table;
    // Support is tickets/feedback. Both owned by eld-fleet-ops.
    CarrierModule,
    SupportModule,
    // Phase 11 — Settings (TZ §16). Integrations (TMS/McLeod, WEX/Comdata, QuickBooks, Slack,
    // generic webhook; secrets encrypted at rest) and outbound webhook delivery
    // (HMAC-SHA256, 3 retries). Owned by eld-reports-jobs.
    IntegrationsModule,
    WebhooksModule,
    // Phase 10 — Operations (TZ §11.5, §14). Dispatch/trips, safety (harsh events, scoring,
    // coaching), Live Fleet geofences, messaging (chat/broadcast), alert rules + the in-app
    // notification inbox, and the realtime WS gateway. Owned by eld-fleet-ops (trips/safety/
    // geofences/messaging), eld-reports-jobs (notifications), eld-realtime-offline (gateway).
    TripsModule,
    SafetyModule,
    GeofencesModule,
    MessagingModule,
    NotificationsModule,
    RealtimeModule,
    // TZ §6.5 — "API 600/daq/token" default bucket; `AuthController` narrows login-family
    // routes to 5/min/IP with `@Throttle()`. Tracked by IP (Nest's default) rather than by
    // token, since the per-token bucket only makes sense once a request is authenticated —
    // a true per-token limiter is a follow-up once `modules/integrations` needs it too.
    // Skipped under NODE_ENV=test so e2e suites that call /auth/login dozens of times don't
    // trip their own 429s; ThrottlerGuard's decision logic is covered by a unit test instead.
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }],
        skipIf: () => config.isTest,
      }),
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: metrics wrap everything, then the response envelope, then audit.
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Overrides CommonModule's NotImplementedTokenVerifier: JwtAuthGuard is instantiated as
    // an APP_GUARD directly in this module's own injector, so a provider declared here for
    // the same token takes precedence over CommonModule's `@Global()` default (modules/auth,
    // TZ §6.3).
    { provide: TokenVerifier, useExisting: TokenService },
    // Same override reasoning as TokenVerifier above, for the API-key half of JwtAuthGuard
    // (modules/api-keys, TZ §6.5/§11.7).
    { provide: ApiKeyVerifier, useExisting: ApiKeysAuthAdapter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TwoFactorSetupGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
