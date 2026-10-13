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
  @ApiOperation({
    summary: 'Gets the single-row carrier/company profile (TZ §5.1).',
    description:
      'pt30_pt40/tz.md §9.3: `virtualEldEnabled`, `virtualEldAvailable` (env VIRTUAL_ELD_ALLOWED; false -> hide the switch), ' +
      '`virtualEldUpdatedAt`, `virtualEldUpdatedBy: { id, name } | null` (back-office user who last flipped the switch).',
  })
  @ApiOkResponse({ schema: { example: { id: 'carrier', name: 'Acme Trucking', dotNumber: '1234567', eldIdentifier: 'OBK001', erodsMode: 'TEST', virtualEldEnabled: false, virtualEldAvailable: true, virtualEldUpdatedAt: null, virtualEldUpdatedById: null, virtualEldUpdatedBy: null } } })
  @ApiStandardErrors()
  get() {
    return this.carrier.view();
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
  @ApiOperation({
    summary: 'Updates the carrier/company profile (Settings screens).',
    description:
      '`virtualEldEnabled` (pt30_pt40/tz.md §9) toggles Test PT30/40 (PT Emulator) mode: 409 `VIRTUAL_ELD_NOT_ALLOWED` when env ' +
      '`VIRTUAL_ELD_ALLOWED` is false; 409 `VIRTUAL_ELD_REQUIRES_TEST_ERODS` when it would be on together with `erodsMode=PRODUCTION` ' +
      '(either direction). A change is audited (`carrier.virtual_eld.enabled` / `.disabled`), pushed as `carrier.updated` on the `fleet` ' +
      'room and as `virtual_eld.changed { enabled }` on every active driver\'s `driver:{id}` room.',
  })
  @ApiOkResponse({ schema: { example: { id: 'carrier', name: 'Universal Logistics Inc.', dotNumber: '1234567', timezone: 'America/New_York', eldIdentifier: 'OBK001', eldRegistrationId: null, erodsMode: 'TEST', virtualEldEnabled: true, virtualEldAvailable: true, virtualEldUpdatedAt: '2026-10-12T09:00:00.000Z', virtualEldUpdatedById: 'usr_1', virtualEldUpdatedBy: { id: 'usr_1', name: 'Jane Admin' } } } })
  @ApiStandardErrors({
    errors: [
      apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'eldIdentifier must be exactly 6 characters (7.15), eldRegistrationId exactly 4 (7.17), from [A-Z0-9] (Appendix A).'),
      apiError.fieldConflicts([
        { code: ERROR_CODES.VIRTUAL_ELD_NOT_ALLOWED, field: 'virtualEldEnabled', message: 'Virtual ELD is not allowed in this environment.' },
        { code: ERROR_CODES.VIRTUAL_ELD_REQUIRES_TEST_ERODS, field: 'erodsMode', message: 'Test PT30/40 mode requires erodsMode=TEST.' },
      ]),
    ],
  })
  update(@Body(zodBody(UpdateCarrierDto)) dto: UpdateCarrierDto) {
    return this.carrier.update(dto);
  }
}
