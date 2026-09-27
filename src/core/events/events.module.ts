import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { EventBusService } from './event-bus.service';
import { RealtimePubSubService } from './realtime-pubsub.service';

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [EventBusService, RealtimePubSubService],
  exports: [EventBusService, RealtimePubSubService],
})
export class EventsModule {}
