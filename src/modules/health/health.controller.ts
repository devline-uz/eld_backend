import { Controller, Get, Header, HttpCode, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse, ERROR_CODES } from '../../common/errors';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { DeepHealth, HealthService } from './health.service';
import { MetricsService } from './metrics.service';

/** TZ §22.5. Controllers hold no logic — every call delegates to a service. */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthService,
    private readonly metrics: MetricsService,
  ) {}

  @Public()
  @Get('health/live')
  @ApiOperation({ summary: 'Liveness probe — answers as long as the process is up (TZ §22.5).' })
  @ApiOkResponse({ description: 'Process is running.', schema: { example: { status: 'ok' } } })
  @ApiErrorResponse({ status: 503, code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Process is shutting down.' })
  live(): { status: 'ok' } {
    return this.health.live();
  }

  @Public()
  @Get('health/ready')
  @ApiOperation({ summary: 'Readiness probe — the instance only takes traffic when the database answers.' })
  @ApiOkResponse({
    description: 'Database reachable; instance can take traffic.',
    schema: { example: { status: 'ok', info: { database: { status: 'up' } }, details: { database: { status: 'up' } } } },
  })
  @ApiErrorResponse({ status: 503, code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'Database is not reachable.' })
  ready(): Promise<unknown> {
    return this.health.ready();
  }

  @Public()
  @Get('health/deep')
  @ApiOperation({ summary: 'Deep probe — database, Redis and object storage checked in parallel.' })
  @ApiOkResponse({
    description: 'Database, Redis and object storage checked in parallel.',
    schema: {
      example: {
        status: 'ok',
        checks: { database: { status: 'up', latencyMs: 3 }, redis: { status: 'up', latencyMs: 1 }, storage: { status: 'up', latencyMs: 12 } },
      },
    },
  })
  @ApiErrorResponse({ status: 503, code: ERROR_CODES.SERVICE_UNAVAILABLE, message: 'At least one dependency is down.' })
  deep(): Promise<DeepHealth> {
    return this.health.deep();
  }

  @Public()
  @Get('metrics')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiExcludeEndpoint()
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.scrape();
  }
}
