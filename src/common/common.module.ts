import { Global, Module } from '@nestjs/common';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { DriverGuard } from './guards/driver.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionGuard } from './guards/permission.guard';
import { NotImplementedTokenVerifier, TokenVerifier } from './guards/token-verifier.port';
import { ApiKeyVerifier, NotImplementedApiKeyVerifier } from './guards/api-key-verifier.port';
import { AuditInterceptor } from './interceptors/audit.interceptor';
import { TransformInterceptor } from './interceptors/transform.interceptor';
import { AuditSnapshotRegistry } from './audit/audit-snapshot.registry';
import { LocationDescriptionService } from './geo-location/location-description.service';

/**
 * Cross-cutting providers. Registration of the global guard/interceptor/filter chain
 * happens in AppModule so the ordering is visible in one place.
 *
 * `TokenVerifier` is bound to a NOT_IMPLEMENTED stub; modules/auth (eld-auth-rbac)
 * overrides this provider. `ApiKeyVerifier` is likewise a stub, overridden by
 * modules/api-keys — see `JwtAuthGuard`.
 */
@Global()
@Module({
  providers: [
    { provide: TokenVerifier, useClass: NotImplementedTokenVerifier },
    { provide: ApiKeyVerifier, useClass: NotImplementedApiKeyVerifier },
    JwtAuthGuard,
    PermissionGuard,
    DriverGuard,
    TransformInterceptor,
    AuditInterceptor,
    AuditSnapshotRegistry,
    LocationDescriptionService,
    AllExceptionsFilter,
  ],
  exports: [
    TokenVerifier,
    ApiKeyVerifier,
    JwtAuthGuard,
    PermissionGuard,
    DriverGuard,
    TransformInterceptor,
    AuditInterceptor,
    AuditSnapshotRegistry,
    LocationDescriptionService,
  ],
})
export class CommonModule {}
