import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto, UpdateApiKeyScopesDto } from './dto/api-keys.dto';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/**
 * TZ §11.7 `/api-keys`, §6.5 — hashed storage, prefix display, scoped/expirable/revocable.
 * Gated by the `integrations` permission key (ADMIN-only per the §6.4 matrix).
 */
@FigmaScreen('web/settings-integrations')
@ApiTags('api-keys')
@ApiBearerAuth()
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @Perm('integrations', 'READ')
  @ApiOperation({ summary: 'Lists API keys — never returns the plaintext key or full hash.' })
  @ApiOkResponse({ schema: { example: [{ id: 'key_1', name: 'McLeod TMS', prefix: 'obk_ABCD', scopes: ['logs:read', 'vehicles:read'], lastUsedAt: '2026-09-11T14:02:00.000Z', expiresAt: null, revokedAt: null }] } })
  @ApiStandardErrors()
  list() {
    return this.apiKeys.list();
  }

  @Post()
  @Perm('integrations', 'FULL')
  @Audit({ object: 'ApiKey', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates an API key. The plaintext key is returned exactly once.' })
  @ApiOkResponse({
    schema: { example: { apiKey: { id: 'key_1', prefix: 'obk_ABCD' }, plaintextKey: 'obk_...(shown once)' } },
  })
  @ApiStandardErrors()
  create(@Body(zodBody(CreateApiKeyDto)) dto: CreateApiKeyDto, @CurrentUser('id') createdById: string) {
    return this.apiKeys.create(dto, createdById);
  }

  @Patch(':id/scopes')
  @Perm('integrations', 'FULL')
  @Audit({ object: 'ApiKey', action: 'UPDATE_SCOPES' })
  @ApiOperation({ summary: 'Changes the scopes granted to an existing API key.' })
  @ApiOkResponse({ schema: { example: { id: 'key_1', prefix: 'obk_ABCD', scopes: ['logs:read'] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'API key not found.'), apiError.conflict(ERROR_CODES.API_KEY_REVOKED, 'A revoked key cannot be modified.')] })
  updateScopes(@Param('id') id: string, @Body(zodBody(UpdateApiKeyScopesDto)) dto: UpdateApiKeyScopesDto) {
    return this.apiKeys.updateScopes(id, dto.scopes);
  }

  @Delete(':id')
  @Perm('integrations', 'FULL')
  @Audit({ object: 'ApiKey', action: 'REVOKE' })
  @ApiOperation({ summary: 'Revokes an API key immediately.' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'API key not found.')] })
  async revoke(@Param('id') id: string) {
    await this.apiKeys.revoke(id);
    return { success: true };
  }
}
