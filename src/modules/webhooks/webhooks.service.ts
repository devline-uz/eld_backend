import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { WebhookDelivery } from '@prisma/client';
import type { Queue } from 'bullmq';
import { QUEUES } from '../../core/queue/queue.constants';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { IntegrationsService } from '../integrations/integrations.service';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';

export interface WebhookJobData {
  deliveryId: string;
}

/**
 * TZ §16 — outbound webhook delivery to the fleet's own endpoint, configured via the generic
 * `webhook` provider row in `Integration` (`config.url`, `config.secret`). Enqueues onto the
 * `webhook` BullMQ queue; `WebhookProcessor` (worker container) does the actual HTTP POST +
 * HMAC signing + 3-retry schedule (1s/10s/60s), recording every attempt on `WebhookDelivery`.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly repo: WebhookDeliveryRepository,
    private readonly integrations: IntegrationsService,
    @InjectQueue(QUEUES.WEBHOOK) private readonly queue: Queue<WebhookJobData>,
  ) {}

  /** Fires an event at the configured `webhook` integration, if one is connected. Returns the
   * created `WebhookDelivery` row, or `null` if no webhook endpoint is configured/enabled —
   * this is a best-effort notification, not a hard dependency for the caller's own operation. */
  async notify(eventType: string, payload: Record<string, unknown>): Promise<WebhookDelivery | null> {
    const integration = await this.integrations.findEnabledByProvider('webhook');
    const url = readUrl(integration?.config);
    if (!integration || !url) {
      this.logger.debug({ eventType }, 'No enabled webhook integration configured — skipping delivery.');
      return null;
    }
    return this.enqueue({ integrationId: integration.id, url, eventType, payload });
  }

  /** Same as `notify`, but throws instead of silently skipping — used by the "send a test
   * event" admin action, where "nothing configured" is the caller's mistake, not a no-op. */
  async sendTest(eventType: string, payload: Record<string, unknown>): Promise<WebhookDelivery> {
    const delivery = await this.notify(eventType, payload);
    if (!delivery) {
      throw new AppException(ERROR_CODES.INTEGRATION_NOT_CONFIGURED, "No enabled 'webhook' integration configured.", 409);
    }
    return delivery;
  }

  private async enqueue(input: {
    integrationId: string | null;
    url: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<WebhookDelivery> {
    const delivery = await this.repo.create({
      integrationId: input.integrationId,
      url: input.url,
      eventType: input.eventType,
      payload: input.payload as never,
    });
    // Retries are scheduled manually by the processor (WebhookDelivery.nextRetryAt / attempts),
    // not by BullMQ's own backoff — the 1s/10s/60s schedule is fixed, not exponential, so each
    // retry is a fresh delayed job rather than relying on `attempts` + `backoff`.
    await this.queue.add('deliver', { deliveryId: delivery.id }, { attempts: 1, removeOnComplete: true, removeOnFail: true });
    return delivery;
  }
}

function readUrl(config: unknown): string | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const url = (config as Record<string, unknown>).url;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}
