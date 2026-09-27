import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AlertRulesController } from './alert-rules.controller';
import { AlertRulesService } from './alert-rules.service';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationChannelsService } from './notification-channels.service';
import { NotificationsController } from './notifications.controller';
import { AlertDeliveryRepository, AlertRulesRepository, NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/** TZ §14 — alert rules (Settings) + the in-app notification inbox + org notification channels. */
@Module({
  imports: [CarrierModule, WebhooksModule],
  controllers: [AlertRulesController, NotificationsController, NotificationChannelsController],
  providers: [
    AlertRulesService,
    AlertRulesRepository,
    NotificationsService,
    NotificationsRepository,
    AlertDeliveryRepository,
    NotificationChannelsService,
  ],
  exports: [AlertRulesRepository, NotificationsRepository, AlertDeliveryRepository, NotificationsService],
})
export class NotificationsModule {}
