import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { UpdateCarrierDto } from './dto/carrier.dto';
import { CarrierService } from './carrier.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/**
 * TZ §5.1, §11.7 `GET/PATCH /carrier` — "Settings > Company profile" Figma screen.
 * Gated by `carrierSettings` (ADMIN-only per §6.4 matrix).
 */
@FigmaScreen('web/settings-company-profile')
@ApiTags('carrier')
@ApiBearerAuth()
@Controller('carrier')
export class CarrierController {
  constructor(private readonly carrier: CarrierService) {}

  @Get()
  @Perm('carrierSettings', 'READ')
  @ApiOperation({ summary: 'Gets the single-row carrier/company profile (TZ §5.1).' })
  @ApiOkResponse({ schema: { example: { id: 'carrier', name: 'Acme Trucking', dotNumber: '1234567', eldIdentifier: 'OBK001', erodsMode: 'TEST' } } })
  @ApiStandardErrors()
  get() {
    return this.carrier.get();
  }

  @Get('transfer-config')
  // B-45 / decisions.md D-095 — `reports:READ`: every seeded role holding `reportsTransfer`
  // also holds `reports`, and the four values are non-sensitive display data.
  @Perm('reports', 'READ')
  @FigmaScreen('web/send-logs-to-safety-official', 'web/reports-fmcsa-audit-pack')
  @ApiOperation({
    summary:
      'B-45 — eRODS transfer settings for the report/transfer screens: timezone, Appendix A identifiers and the TEST/PRODUCTION mode (read-only).',
  })
  @ApiOkResponse({ schema: { example: { timezone: 'America/New_York', eldIdentifier: 'OBK001', eldRegistrationId: null, erodsMode: 'TEST' } } })
  @ApiStandardErrors()
  getTransferConfig() {
    return this.carrier.getTransferConfig();
  }

  @Patch()
  @Perm('carrierSettings', 'FULL')
  @Audit({ object: 'Carrier', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates the carrier/company profile (Settings screens).' })
  @ApiOkResponse({ schema: { example: { id: 'carrier', name: 'Universal Logistics Inc.', dotNumber: '1234567', timezone: 'America/New_York', eldIdentifier: 'OBK001', eldRegistrationId: null, erodsMode: 'TEST' } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'eldIdentifier must be exactly 6 characters (7.15), eldRegistrationId exactly 4 (7.17), from [A-Z0-9] (Appendix A).')] })
  update(@Body(zodBody(UpdateCarrierDto)) dto: UpdateCarrierDto) {
    return this.carrier.update(dto);
  }
}
