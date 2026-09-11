import { Injectable } from '@nestjs/common';
import type { Integration } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { UpsertIntegrationDto, INTEGRATION_PROVIDERS } from './dto/integrations.dto';
import { IntegrationsRepository } from './integrations.repository';
import { IntegrationCipherService } from './lib/integration-cipher.service';
import { decryptConfigSecret, encryptConfigSecrets, redactConfigSecrets } from './lib/config-secrets';

export type IntegrationView = Omit<Integration, 'config'> & { config: Record<string, unknown> };

function toView(integration: Integration): IntegrationView {
  return { ...integration, config: redactConfigSecrets(integration.config) };
}

/**
 * TZ §16 — TMS (McLeod), fuel card (WEX/Comdata), QuickBooks, Slack, generic webhook.
 * Config secrets are encrypted at rest (`IntegrationCipherService`, AES-256-GCM) and a
 * plaintext/ciphertext value never leaves this module: every response, and every audit-log
 * snapshot, goes through `redactConfigSecrets` first (see `getRedactedSnapshot`, registered
 * with `AuditSnapshotRegistry` in `IntegrationsModule`).
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly repo: IntegrationsRepository,
    private readonly cipher: IntegrationCipherService,
  ) {}

  async list(): Promise<IntegrationView[]> {
    return (await this.repo.list()).map(toView);
  }

  async get(provider: string): Promise<IntegrationView> {
    const integration = await this.findOrThrow(provider);
    return toView(integration);
  }

  /** Creates or reconfigures a provider connection. Secret-looking config fields (api key,
   * client secret, access/refresh token, signing secret) are encrypted before the row is
   * written; the response never echoes them back, even encrypted. */
  async upsert(provider: string, dto: UpsertIntegrationDto): Promise<IntegrationView> {
    this.assertKnownProvider(provider);
    const encryptedConfig = encryptConfigSecrets(dto.config, this.cipher);
    const integration = await this.repo.upsert(provider, {
      enabled: dto.enabled,
      config: encryptedConfig as never,
      status: dto.enabled ? 'CONNECTED' : 'DISCONNECTED',
      lastError: null,
    });
    return toView(integration);
  }

  /** Disconnects a provider: disables it and drops the stored config (including its encrypted
   * secrets) rather than leaving stale credentials at rest. */
  async disconnect(provider: string): Promise<IntegrationView> {
    await this.findOrThrow(provider);
    const integration = await this.repo.upsert(provider, {
      enabled: false,
      config: {},
      status: 'DISCONNECTED',
      lastError: null,
    });
    return toView(integration);
  }

  async markError(provider: string, message: string): Promise<void> {
    await this.repo.setStatus(provider, 'ERROR', message);
  }

  async markSynced(provider: string): Promise<void> {
    await this.repo.setStatus(provider, 'CONNECTED', null, new Date());
  }

  /** Internal-only decrypt, for a processor that must actually call the provider or sign a
   * webhook. Never routed through a controller. Throws if the provider isn't configured/enabled
   * so callers don't silently deliver to a stale/disabled integration. */
  async getDecryptedSecret(provider: string, key: string): Promise<string> {
    const integration = await this.repo.findByProvider(provider);
    if (!integration || !integration.enabled) {
      throw new AppException(
        ERROR_CODES.INTEGRATION_NOT_CONFIGURED,
        `Integration '${provider}' is not configured or is disabled.`,
        409,
      );
    }
    const secret = decryptConfigSecret(integration.config, key, this.cipher);
    if (!secret) {
      throw new AppException(
        ERROR_CODES.INTEGRATION_NOT_CONFIGURED,
        `Integration '${provider}' is missing required config field '${key}'.`,
        409,
      );
    }
    return secret;
  }

  async findEnabledByProvider(provider: string): Promise<Integration | null> {
    const integration = await this.repo.findByProvider(provider);
    return integration?.enabled ? integration : null;
  }

  /** Redacted snapshot for `AuditSnapshotRegistry` — audit log rows must never carry even the
   * ciphertext blob, only a `[REDACTED]` marker (TZ §18). */
  async getRedactedSnapshot(provider: string): Promise<Record<string, unknown> | null> {
    const integration = await this.repo.findByProvider(provider);
    return integration ? toView(integration) : null;
  }

  private assertKnownProvider(provider: string): void {
    if (!(INTEGRATION_PROVIDERS as readonly string[]).includes(provider)) {
      throw new AppException(
        ERROR_CODES.VALIDATION_FAILED,
        `Unknown integration provider '${provider}'. Expected one of: ${INTEGRATION_PROVIDERS.join(', ')}.`,
        422,
      );
    }
  }

  private async findOrThrow(provider: string): Promise<Integration> {
    const integration = await this.repo.findByProvider(provider);
    if (!integration) throw AppException.notFound(`Integration '${provider}' not found.`);
    return integration;
  }
}
