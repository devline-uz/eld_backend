import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { VerifyEmailChangeDto } from '../auth/dto/auth.dto';
import { UserEmailChangeService } from './user-email-change.service';

/**
 * B-84 web-user email change — the PUBLIC landing endpoints behind the emailed links (web pages
 * `/account/email/confirm` and `/account/email/cancel` post the `token` here). The tokens are
 * self-authenticating; audit entries are written by the service (no `:id` route). Same shape as
 * the driver's `auth/driver/email/*`.
 */
@ApiTags('auth')
@Controller('auth/email')
export class UserEmailController {
  constructor(private readonly emailChange: UserEmailChangeService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'B-84 — confirms a `PATCH /users/:id { email }` change from the link mailed to the NEW address.',
    description:
      'Posted by the web page `/account/email/confirm`. The token is bound to the user, the pending address and the request ' +
      'time, so a newer request or a cancel invalidates it. Swaps `email`, starts the `USER_EMAIL_CHANGE_HOLD_HOURS` hold, ' +
      'unbinds the old Google identity and revokes every session. `alreadyVerified: true` on a repeat click (nothing written).',
  })
  @ApiOkResponse({ schema: { example: { success: true, email: 'new@example.com', alreadyVerified: false } } })
  @ApiStandardErrors({
    public: true,
    errors: [
      { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'This confirmation link is no longer valid.' },
      apiError.conflict(ERROR_CODES.EMAIL_TAKEN, 'A user with this email address already exists.'),
      apiError.rateLimited('10 requests per minute per IP.'),
    ],
  })
  verify(@Body(zodBody(VerifyEmailChangeDto)) dto: VerifyEmailChangeDto) {
    return this.emailChange.confirm(dto.token);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'B-84 — "This wasn\'t me" from the notice mailed to a web user\'s OLD address.',
    description:
      'Posted by the web page `/account/email/cancel`. Cancels a pending change (`result: CANCELLED`), or inside the hold ' +
      'window reverts a confirmed one and revokes every session (`result: REVERTED`).',
  })
  @ApiOkResponse({ schema: { example: { success: true, result: 'CANCELLED' } } })
  @ApiStandardErrors({
    public: true,
    errors: [
      { status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'This link can no longer cancel the change. Contact your administrator.' },
      apiError.conflict(ERROR_CODES.EMAIL_TAKEN, 'A user with this email address already exists.'),
      apiError.rateLimited('10 requests per minute per IP.'),
    ],
  })
  cancel(@Body(zodBody(VerifyEmailChangeDto)) dto: VerifyEmailChangeDto) {
    return this.emailChange.cancelFromLink(dto.token);
  }
}
