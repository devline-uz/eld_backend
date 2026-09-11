import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/config.service';
import { QUEUES } from './queue.constants';

const queues = Object.values(QUEUES).map((name) => ({ name }));

/**
 * TZ §3.3 — one code base, two containers. The API registers the queues so it can
 * enqueue; worker.ts registers the processors. Heavy work never runs in the API.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: {
          url: config.get('REDIS_URL'),
          db: config.get('REDIS_DB'),
          maxRetriesPerRequest: null,
        },
        prefix: config.get('QUEUE_PREFIX'),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      }),
    }),
    BullModule.registerQueue(...queues),
  ],
  exports: [BullModule],
})
export class QueueModule {}
