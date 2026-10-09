import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiStandardErrors } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import { MobileContactResponse } from './dto/mobile.responses';
import { MobileContactsService } from './mobile-contacts.service';

/** mobile/tz.md §21.1 MB-14, screens M-15/M-16 — the driver's in-app contact list. */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/contacts')
export class MobileContactsController {
  constructor(private readonly service: MobileContactsService) {}

  @Get()
  @ApiOperation({ summary: 'M-15/M-16 — ADMIN/FLEET_MANAGER/DISPATCHER staff, the active co-driver, and a synthetic support entry.' })
  @ApiEnvelopeResponse(MobileContactResponse, { isArray: true, example: [{ id: 'usr_1', name: 'Mike Torres', role: 'FLEET_MANAGER', phone: '+1-555-0100' }, { id: 'support', name: 'OneBook ELD Support', role: 'SUPPORT', phone: null }] })
  @ApiStandardErrors()
  list(@CurrentUser('id') driverId: string) {
    return this.service.list(driverId);
  }
}
