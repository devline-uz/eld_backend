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
  @ApiOkResponse({ schema: { example: { id: 'carrier', name: 'Acme Trucking', dotNumber: '1234567', eldIdentifier: 'OBK1', erodsMode: 'TEST' } } })
  @ApiStandardErrors()
  get() {
    return this.carrier.get();
  }

  @Patch()
  @Perm('carrierSettings', 'FULL')
  @Audit({ object: 'Carrier', action: 'UPDATE' })
  @ApiOperation({ summary: 'Updates the carrier/company profile (Settings screens).' })
  @ApiOkResponse({ schema: { example: { id: 'carrier', name: 'Universal Logistics Inc.', dotNumber: '1234567', timezone: 'America/New_York', eldIdentifier: 'OBK1', eldRegistrationId: null, erodsMode: 'TEST' } } })
  @ApiStandardErrors({ errors: [apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'eldIdentifier must be exactly 4 characters from [A-Z0-9] (Appendix A).')] })
  update(@Body(zodBody(UpdateCarrierDto)) dto: UpdateCarrierDto) {
    return this.carrier.update(dto);
  }
}
