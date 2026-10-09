import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import { TokenPairResponse } from '../auth/dto/auth.responses';
import { AuthService } from '../auth/auth.service';
import { CoDriverSwitchDto } from './dto/mobile-fleet-ops.dto';
import { CoDriverLeaveResponse, CoDriverPairingResponse } from './dto/mobile.responses';
import { MobileCoDriverService } from './mobile-codriver.service';

/** mobile/tz.md §21.1 MB-3, screens S-11/S-18/S-19 — driver-seat handoff. */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/co-driver')
export class MobileCoDriverController {
  constructor(private readonly service: MobileCoDriverService) {}

  @Get()
  @ApiOperation({ summary: 'MR-15 — the caller\'s active co-driver pairing (either seat) with the co-driver\'s identity and the active trip\'s documents/trailers; `null` when not paired.' })
  @ApiEnvelopeResponse(CoDriverPairingResponse, {
    nullable: true,
    description: '`data` is null when the caller is not paired; `trip` is absent when there is no active trip.',
    example: {
      pairingId: 'pair_1',
      startedAt: '2026-10-08T08:00:00.000Z',
      coDriver: { id: 'drv_2', firstName: 'Jane', lastName: 'Doe', username: 'jdoe' },
      trip: { shippingDocuments: ['BOL-2201'], trailerNumbers: ['TR-1'] },
    },
  })
  @ApiStandardErrors()
  current(@CurrentUser('id') driverId: string) {
    return this.service.current(driverId);
  }

  /** B-119 — this route verifies the co-driver's PASSWORD and returns their tokens, so it is
   * a login endpoint and gets the same 5/min/IP budget as `/auth/driver/login` (§6.5). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('switch')
  @ApiOperation({ summary: 'S-11/S-18/S-19 — hands the driver seat to the paired co-driver; returns the CO-DRIVER\'s own token pair.' })
  @ApiEnvelopeResponse(TokenPairResponse, { status: 201, example: { accessToken: 'eyJ...', refreshToken: 'a1b2...', tokenType: 'Bearer' } })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'No active co-driver pairing for this driver.'),
      apiError.unprocessable(ERROR_CODES.CO_DRIVER_PASSWORD_INVALID, 'The co-driver password is incorrect.'),
    ],
  })
  switch(@Body(zodBody(CoDriverSwitchDto)) dto: CoDriverSwitchDto, @CurrentUser() actor: ContextUser, @Req() req: Request) {
    return this.service.switch(actor.id, dto, actor, AuthService.meta(req));
  }

  @Post('leave')
  @ApiOperation({
    summary: 'S-19 — ends the active co-driver pairing and clears the leaving driver\'s assigned unit.',
    description: 'Without an active pairing it is a no-op returning `{ended:false}` and the unit is NOT released; use `POST /mobile/release-vehicle` for that (MR-2).',
  })
  @ApiEnvelopeResponse(CoDriverLeaveResponse, { status: 201, example: { ended: true } })
  @ApiStandardErrors()
  leave(@CurrentUser() actor: ContextUser) {
    return this.service.leave(actor.id, actor);
  }
}
