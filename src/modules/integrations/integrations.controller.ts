import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { IntegrationsService } from './integrations.service';
import { UpsertIntegrationDto } from './dto/integrations.dto';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/**
 * TZ §16 `/integrations` — TMS/McLeod, WEX/Comdata, QuickBooks, Slack, generic webhook.
 * Gated by the `integrations` permission key. Config secrets never appear in a response —
 * see `IntegrationsService`/`redactConfigSecrets`.
 */
@FigmaScreen('web/settings-integrations')
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @Perm('integrations', 'READ')
  @ApiOperation({ summary: 'Lists configured integrations. Secret config fields are redacted.' })
  @ApiOkResponse({ description: 'Secret config fields come back as `***`.', schema: { example: [{ id: 'int_1', provider: 'mcleod', enabled: true, status: 'CONNECTED', lastSyncAt: '2026-09-11T09:12:00.000Z', config: { baseUrl: 'https://tms.example.com', apiToken: '***' } }] } })
  @ApiStandardErrors()
  list() {
    return this.integrations.list();
  }

  @Get(':provider')
  @Perm('integrations', 'READ')
  @ApiOperation({ summary: 'Fetches one integration. Secret config fields are redacted.' })
  @ApiOkResponse({ schema: { example: { id: 'int_1', provider: 'wex', enabled: true, status: 'CONNECTED', config: { accountId: '4821', apiKey: '***' } } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.INTEGRATION_NOT_CONFIGURED, 'This provider is not configured.')] })
  get(@Param('provider') provider: string) {
    return this.integrations.get(provider);
  }

  @Put(':provider')
  @Perm('integrations', 'FULL')
  @Audit({ object: 'Integration', action: 'UPDATE', idParam: 'provider' })
  @ApiOperation({ summary: 'Creates or reconfigures a provider connection; secrets are encrypted at rest.' })
  @ApiOkResponse({ schema: { example: { id: 'int_1', provider: 'mcleod', enabled: true, status: 'CONNECTED' } } })
  @ApiStandardErrors()
  upsert(@Param('provider') provider: string, @Body(zodBody(UpsertIntegrationDto)) dto: UpsertIntegrationDto) {
    return this.integrations.upsert(provider, dto);
  }

  @Delete(':provider')
  @Perm('integrations', 'FULL')
  @Audit({ object: 'Integration', action: 'DISCONNECT', idParam: 'provider' })
  @ApiOperation({ summary: 'Disconnects a provider and drops its stored config/secrets.' })
  @ApiOkResponse({ description: 'Config and secrets are dropped; the row stays for the audit trail.', schema: { example: { id: 'int_1', provider: 'mcleod', enabled: false, status: 'DISCONNECTED' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.INTEGRATION_NOT_CONFIGURED, 'This provider is not configured.')] })
  disconnect(@Param('provider') provider: string) {
    return this.integrations.disconnect(provider);
  }
}
