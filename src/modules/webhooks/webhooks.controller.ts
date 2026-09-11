import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { SendTestWebhookDto } from './dto/webhooks.dto';
import { WebhooksService } from './webhooks.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';

/** TZ §16 — lets an admin verify a configured `webhook` endpoint before relying on it. */
@FigmaScreen('web/settings-integrations')
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations/webhook')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('test')
  @Perm('integrations', 'FULL')
  @ApiOperation({ summary: 'Sends a signed test event to the configured webhook endpoint.' })
  @ApiOkResponse({ schema: { example: { id: 'whd_1', status: 'QUEUED', attempts: 0 } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.INTEGRATION_NOT_CONFIGURED, 'No webhook endpoint is configured.'), apiError.unprocessable(ERROR_CODES.WEBHOOK_DELIVERY_FAILED, 'The endpoint rejected the signed test event.')] })
  sendTest(@Body(zodBody(SendTestWebhookDto)) dto: SendTestWebhookDto) {
    return this.webhooks.sendTest(dto.eventType, dto.payload);
  }
}
