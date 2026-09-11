import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppConfigModule } from './core/config/config.module';
import { EventsModule } from './core/events/events.module';
import { FirebaseModule } from './core/firebase/firebase.module';
import { AppLoggerModule } from './core/logger/logger.module';
import { PrismaModule } from './core/prisma/prisma.module';
import { QueueModule } from './core/queue/queue.module';
import { StorageModule } from './core/storage/storage.module';
import { WorkersModule } from './workers/workers.module';

/**
 * Worker composition root. Same code base as the API (TZ §3.3) but deliberately WITHOUT
 * controllers, guards, filters or the HTTP stack — a BullMQ processor has no request.
 * The db-guard still runs, because AppConfigModule is imported here too.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    PrismaModule,
    QueueModule,
    StorageModule,
    FirebaseModule,
    EventsModule,
    WorkersModule,
  ],
})
export class WorkerAppModule {}

async function bootstrap(): Promise<void> {
  // createApplicationContext = no HTTP listener.
  const app = await NestFactory.createApplicationContext(WorkerAppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  logger.log('Worker started — BullMQ processors registered');
}

void bootstrap();
