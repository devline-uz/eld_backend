import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * TZ §16 — outbound webhook delivery (HMAC-SHA256, 3 retries at 1s/10s/60s). The actual send
 * happens in `WebhookProcessor` (`src/workers/webhook.processor.ts`), loaded only by the
 * worker container; this module provides the enqueue side used by the API and, later, by
 * other modules that fire domain events (e.g. `alert.processor`, Phase 10).
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDeliveryRepository],
  exports: [WebhooksService, WebhookDeliveryRepository],
})
export class WebhooksModule {}
