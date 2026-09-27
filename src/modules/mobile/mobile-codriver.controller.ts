import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { AuthService } from '../auth/auth.service';
import { CoDriverSwitchDto } from './dto/mobile-fleet-ops.dto';
import { MobileCoDriverService } from './mobile-codriver.service';

/** mobile/tz.md §21.1 MB-3, screens S-11/S-18/S-19 — driver-seat handoff. */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/co-driver')
export class MobileCoDriverController {
  constructor(private readonly service: MobileCoDriverService) {}

  @Post('switch')
  @ApiOperation({ summary: 'S-11/S-18/S-19 — hands the driver seat to the paired co-driver; returns the CO-DRIVER\'s own token pair.' })
  @ApiCreatedResponse({ schema: { example: { accessToken: 'eyJ...', refreshToken: 'a1b2...', tokenType: 'Bearer' } } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'No active co-driver pairing for this driver.'),
      apiError.unauthorized('Invalid co-driver password.'),
    ],
  })
  switch(@Body(zodBody(CoDriverSwitchDto)) dto: CoDriverSwitchDto, @CurrentUser() actor: ContextUser, @Req() req: Request) {
    return this.service.switch(actor.id, dto, actor, AuthService.meta(req));
  }

  @Post('leave')
  @ApiOperation({ summary: 'S-19 — ends the active co-driver pairing and clears the leaving driver\'s assigned unit.' })
  @ApiOkResponse({ schema: { example: { ended: true } } })
  @ApiStandardErrors()
  leave(@CurrentUser() actor: ContextUser) {
    return this.service.leave(actor.id, actor);
  }
}
