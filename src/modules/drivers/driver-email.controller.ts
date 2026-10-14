import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { DriverEmailChangeService } from './driver-email-change.service';
import { DriverEmailChangeTokenDto } from './dto/drivers.dto';

/**
 * Driver email change — the PUBLIC landing endpoints behind the emailed links (web pages
 * `/driver-email/confirm`, `/driver-email/cancel` and `/driver-email/verify` post the `token` here). Same idea as the
 * users' `POST /auth/email/verify`; audit entries are written by the service (no `:id` route).
 */
@ApiTags('auth')
@Controller('auth/driver/email')
export class DriverEmailController {
  constructor(private readonly emailChange: DriverEmailChangeService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirms a driver email change from the link mailed to the NEW address.',
    description: 'Swaps `email` to the pending address, sets `emailVerifiedAt`, starts the reset hold and revokes every driver session.',
  })
  @ApiOkResponse({ schema: { example: { success: true, email: 'new@example.com' } } })
  @ApiStandardErrors({
    public: true,
    errors: [
      { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'This confirmation link is no longer valid.' },
      apiError.conflict(ERROR_CODES.EMAIL_TAKEN, 'A driver with this email address already exists.'),
      apiError.rateLimited('10 requests per minute per IP.'),
    ],
  })
  confirm(@Body(zodBody(DriverEmailChangeTokenDto)) dto: DriverEmailChangeTokenDto) {
    return this.emailChange.confirm(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'B-29/B-31 — verifies `Driver.email` from the link mailed by `POST /drivers/:id/send-verification`.',
    description: 'Public: the driver id comes from the signed token, which is bound to the driver and the address it was sent to. Sets `emailVerifiedAt`; `alreadyVerified: true` on a repeat click (nothing written).',
  })
  @ApiOkResponse({ schema: { example: { success: true, email: 'jsmith@example.com', alreadyVerified: false } } })
  @ApiStandardErrors({
    public: true,
    errors: [
      { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'This verification link is no longer valid.' },
      { status: 401, code: ERROR_CODES.TOKEN_EXPIRED, message: 'Token expired.' },
      apiError.rateLimited('10 requests per minute per IP.'),
    ],
  })
  verify(@Body(zodBody(DriverEmailChangeTokenDto)) dto: DriverEmailChangeTokenDto) {
    return this.emailChange.verifyEmailFromLink(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: '"This wasn\'t me" from the notice mailed to the OLD address.',
    description: 'Cancels a pending change (`result: CANCELLED`), or inside the hold window reverts a confirmed one and revokes every driver session (`result: REVERTED`).',
  })
  @ApiOkResponse({ schema: { example: { success: true, result: 'CANCELLED' } } })
  @ApiStandardErrors({
    public: true,
    errors: [
      { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'This link can no longer cancel the change. Contact your carrier.' },
      apiError.conflict(ERROR_CODES.EMAIL_TAKEN, 'A driver with this email address already exists.'),
      apiError.rateLimited('10 requests per minute per IP.'),
    ],
  })
  cancel(@Body(zodBody(DriverEmailChangeTokenDto)) dto: DriverEmailChangeTokenDto) {
    return this.emailChange.cancelFromLink(dto.token);
  }
}
