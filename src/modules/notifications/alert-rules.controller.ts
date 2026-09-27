import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { AlertRulesService } from './alert-rules.service';
import { CreateAlertRuleDto, UpdateAlertRuleDto } from './dto/notifications.dto';

/** TZ §14 — "Settings · Alert rules". Gated by `alertRules` (ADMIN/FLEET_MANAGER FULL only). */
@FigmaScreen('web/settings-alert-rules')
@ApiTags('alert-rules')
@ApiBearerAuth()
@Controller('alert-rules')
export class AlertRulesController {
  constructor(private readonly alertRules: AlertRulesService) {}

  @Get()
  @Perm('alertRules', 'READ')
  @ApiOperation({ summary: 'Lists alert rules (channels, throttle, quiet hours, recipients).' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'alr_1', key: 'hos_violation', name: 'HOS violation', severity: 'CRITICAL', channels: ['IN_APP', 'EMAIL'], enabled: true }] } } })
  @ApiStandardErrors()
  list() {
    return this.alertRules.list();
  }

  @Get(':id')
  @Perm('alertRules', 'READ')
  @ApiOperation({ summary: 'One alert rule.' })
  @ApiOkResponse({ schema: { example: { id: 'alr_1', key: 'hos_violation', channels: ['IN_APP', 'EMAIL'] } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Alert rule not found.')] })
  get(@Param('id') id: string) {
    return this.alertRules.get(id);
  }

  @Post()
  @Perm('alertRules', 'FULL')
  @Audit({ object: 'AlertRule', action: 'CREATE' })
  @ApiOperation({ summary: 'Creates a custom alert rule. `channels: ["SMS"]` is rejected — SMS ships in v2.' })
  @ApiCreatedResponse({ schema: { example: { id: 'alr_2', key: 'custom_geofence_exit', channels: ['IN_APP'] } } })
  @ApiStandardErrors({
    errors: [
      apiError.conflict(ERROR_CODES.CONFLICT, 'An alert rule with this key already exists.'),
      { status: 422, code: ERROR_CODES.CHANNEL_NOT_AVAILABLE, message: 'SMS is not available yet.', details: { channel: 'SMS', availableIn: 'v2' } },
    ],
  })
  create(@Body(zodBody(CreateAlertRuleDto)) dto: CreateAlertRuleDto) {
    return this.alertRules.create(dto);
  }

  @Patch(':id')
  @Perm('alertRules', 'FULL')
  @Audit({ object: 'AlertRule', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates an alert rule (channels, throttle, quiet hours, recipients, enabled).' })
  @ApiOkResponse({ schema: { example: { id: 'alr_1', enabled: false } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Alert rule not found.'),
      apiError.unprocessable(ERROR_CODES.ALERT_RULE_INVALID, 'System alert rules cannot change key/conditions.'),
      { status: 422, code: ERROR_CODES.CHANNEL_NOT_AVAILABLE, message: 'SMS is not available yet.', details: { channel: 'SMS', availableIn: 'v2' } },
    ],
  })
  update(@Param('id') id: string, @Body(zodBody(UpdateAlertRuleDto)) dto: UpdateAlertRuleDto) {
    return this.alertRules.update(id, dto);
  }

  @Delete(':id')
  @Perm('alertRules', 'FULL')
  @Audit({ object: 'AlertRule', action: 'DELETE' })
  @ApiOperation({ summary: 'Deletes a custom alert rule (system rules cannot be deleted).' })
  @ApiOkResponse({ schema: { example: { id: 'alr_2', deleted: true } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Alert rule not found.'),
      apiError.unprocessable(ERROR_CODES.ALERT_RULE_INVALID, 'System alert rules cannot be deleted.'),
    ],
  })
  remove(@Param('id') id: string) {
    return this.alertRules.remove(id);
  }

  @Post(':id/test')
  @Perm('alertRules', 'FULL')
  // B-092 — each call fans out to every configured webhook and writes a notification row;
  // throttled per principal and audited so it cannot be used as a spam/amplification pump.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Audit({ object: 'AlertRule', action: 'TEST' })
  @ApiOperation({ summary: "Sends a test notification through the rule's own channels to the caller. A disabled rule triggers nothing." })
  @ApiOkResponse({ schema: { example: { triggered: true } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Alert rule not found.')] })
  test(@Param('id') id: string, @CurrentUser() actor: ContextUser) {
    return this.alertRules.testRule(id, actor);
  }
}
