import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { AppException } from '../errors/app.exception';

/**
 * Port between the transport-level JwtAuthGuard and modules/api-keys. Mirrors
 * `TokenVerifier` (TZ §6.3 pattern) so the guard stays transport-only: it only needs to
 * know "does this plaintext API key resolve to a caller", not how keys are hashed/stored.
 *
 * TZ §11.7/§6.5 "an API key can be issued, used, and revoked" — this is the "used" half:
 * `ApiKeysService.verify()` existed but nothing ever called it from an HTTP entrypoint.
 */
export abstract class ApiKeyVerifier {
  abstract verify(plaintextKey: string): Promise<ContextUser>;
}

/** Default binding until modules/api-keys overrides it. */
@Injectable()
export class NotImplementedApiKeyVerifier extends ApiKeyVerifier {
  verify(_plaintextKey: string): Promise<ContextUser> {
    return Promise.reject(AppException.notImplemented('API key verification (modules/api-keys)'));
  }
}
