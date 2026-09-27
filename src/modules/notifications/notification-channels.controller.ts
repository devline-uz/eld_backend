import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { ApiStandardErrors } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { NotificationChannelsDto } from './dto/notifications.dto';
import { NotificationChannelsService } from './notification-channels.service';

/**
 * TZ §20 B-87 — "Settings · Alert rules" org-level Email/Webhook switches. Gated by the
 * same `alertRules` permission key as the alert-rule CRUD (same settings page, same audience).
 */
@FigmaScreen('web/settings-alert-rules')
@ApiTags('notification-channels')
@ApiBearerAuth()
@Controller('notification-channels')
export class NotificationChannelsController {
  constructor(private readonly channels: NotificationChannelsService) {}

  @Get()
  @Perm('alertRules', 'READ')
  @ApiOperation({ summary: 'Org-level notification channel toggles (email, webhook).' })
  @ApiOkResponse({ schema: { example: { email: { enabled: true }, webhook: { enabled: false } } } })
  @ApiStandardErrors()
  get() {
    return this.channels.get();
  }

  @Patch()
  @Perm('alertRules', 'FULL')
  @Audit({ object: 'Carrier', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates org-level notification channel toggles. A disabled channel suppresses delivery for every alert rule.' })
  @ApiOkResponse({ schema: { example: { email: { enabled: true }, webhook: { enabled: false } } } })
  @ApiStandardErrors({ validation: true })
  update(@Body(zodBody(NotificationChannelsDto)) dto: NotificationChannelsDto) {
    return this.channels.update(dto);
  }
}
