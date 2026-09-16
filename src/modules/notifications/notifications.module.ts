import { Module } from '@nestjs/common';
import { AlertRulesController } from './alert-rules.controller';
import { AlertRulesService } from './alert-rules.service';
import { NotificationsController } from './notifications.controller';
import { AlertDeliveryRepository, AlertRulesRepository, NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/** TZ §14 — alert rules (Settings) + the in-app notification inbox. */
@Module({
  controllers: [AlertRulesController, NotificationsController],
  providers: [AlertRulesService, AlertRulesRepository, NotificationsService, NotificationsRepository, AlertDeliveryRepository],
  exports: [AlertRulesRepository, NotificationsRepository, AlertDeliveryRepository, NotificationsService],
})
export class NotificationsModule {}
