import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingRepository } from './messaging.repository';
import { MessagingService } from './messaging.service';

/** TZ §11.5 — chat and broadcast. */
@Module({
  controllers: [MessagingController],
  providers: [MessagingService, MessagingRepository],
  exports: [MessagingService, MessagingRepository],
})
export class MessagingModule {}
