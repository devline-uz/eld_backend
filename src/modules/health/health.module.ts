import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthRepository } from './health.repository';
import { HealthService } from './health.service';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';

@Module({
  controllers: [HealthController],
  providers: [HealthService, HealthRepository, MetricsService, MetricsInterceptor],
  exports: [MetricsService, MetricsInterceptor],
})
export class HealthModule {}
