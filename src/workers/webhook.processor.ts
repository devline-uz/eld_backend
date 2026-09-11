import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../core/queue/queue.constants';
import { IntegrationsService } from '../modules/integrations/integrations.service';
import { WebhookDeliveryRepository } from '../modules/webhooks/webhook-delivery.repository';
import { buildSignatureHeader } from '../modules/webhooks/lib/webhook-signature';
import type { WebhookJobData } from '../modules/webhooks/webhooks.service';

/** TZ §16 — fixed retry schedule (not exponential): 1s, then 10s, then 60s after the first
 * failure. `WebhookDelivery.attempts` (persisted) drives the schedule, not BullMQ's own
 * `attemptsMade`, so a delivery's history survives a worker restart. */
const RETRY_SCHEDULE_MS = [1_000, 10_000, 60_000];
const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_CAP = 2_000;

@Processor(QUEUES.WEBHOOK)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private readonly deliveries: WebhookDeliveryRepository,
    private readonly integrations: IntegrationsService,
    @InjectQueue(QUEUES.WEBHOOK) private readonly queue: Queue<WebhookJobData>,
  ) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    const delivery = await this.deliveries.findById(job.data.deliveryId);
    if (!delivery) {
      this.logger.warn({ deliveryId: job.data.deliveryId }, 'WebhookDelivery row missing — skipping.');
      return;
    }

    const rawBody = JSON.stringify(delivery.payload);
    // Decrypted fresh from `Integration.config` on every attempt — the secret is never carried
    // in the BullMQ job payload nor persisted anywhere in plaintext (TZ §16 / D-0xx below).
    const signature = delivery.integrationId
      ? buildSignatureHeader(await this.integrations.getDecryptedSecret('webhook', 'secret'), rawBody)
      : buildSignatureHeader('unsigned-test-delivery', rawBody);

    const nextAttempt = delivery.attempts + 1;
    let httpStatus: number | undefined;
    let responseBody: string | undefined;
    let ok = false;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(delivery.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-OneBook-Signature': signature },
          body: rawBody,
          signal: controller.signal,
        });
        httpStatus = res.status;
        responseBody = (await res.text()).slice(0, RESPONSE_BODY_CAP);
        ok = res.status >= 200 && res.status < 300;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      responseBody = err instanceof Error ? err.message.slice(0, RESPONSE_BODY_CAP) : 'Unknown delivery error';
    }

    if (ok) {
      await this.deliveries.recordAttempt(delivery.id, {
        status: 'SENT',
        attempts: nextAttempt,
        signature,
        httpStatus,
        responseBody,
        nextRetryAt: null,
      });
      return;
    }

    if (nextAttempt < MAX_ATTEMPTS) {
      const delayMs = RETRY_SCHEDULE_MS[nextAttempt - 1];
      await this.deliveries.recordAttempt(delivery.id, {
        status: 'QUEUED',
        attempts: nextAttempt,
        signature,
        httpStatus,
        responseBody,
        nextRetryAt: new Date(Date.now() + delayMs),
      });
      await this.queue.add(
        'deliver',
        { deliveryId: delivery.id },
        { delay: delayMs, attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
      this.logger.warn(
        { deliveryId: delivery.id, attempt: nextAttempt, delayMs, httpStatus },
        'Webhook delivery failed — retry scheduled.',
      );
      return;
    }

    await this.deliveries.recordAttempt(delivery.id, {
      status: 'FAILED',
      attempts: nextAttempt,
      signature,
      httpStatus,
      responseBody,
      nextRetryAt: null,
    });
    this.logger.error({ deliveryId: delivery.id, httpStatus, responseBody }, 'Webhook delivery failed permanently.');
  }
}
