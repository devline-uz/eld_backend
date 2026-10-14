import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import { AuthService } from './auth.service';
import { DriverLoginResponse, MeResponse, PasswordResetCodeSentResponse, PasswordResetCompletedResponse, TokenPairResponse } from './dto/auth.responses';
import { PasswordResetCodeService } from './password-reset-code.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import {
  ConfirmPasswordResetCodeDto,
  DriverLoginDto,
  DriverForgotPasswordDto,
  DriverResetPasswordDto,
  ForgotPasswordDto,
  GoogleLoginDto,
  LoginDto,
  LogoutDto,
  RefreshTokenDto,
  RequestPasswordResetCodeDto,
  ResetPasswordDto,
} from './dto/auth.dto';

/** TZ §11.1 — auth endpoint list. Every rule lives in AuthService; this stays thin. */
@FigmaScreen('web/sign-in')
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly resetCodes: PasswordResetCodeService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'Back-office password login (TZ §6.1).' })
  @ApiOkResponse({
    description: 'Access+refresh tokens.',
    schema: { example: { accessToken: 'eyJ...', refreshToken: 'a1b2...', tokenType: 'Bearer' } },
  })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.INVALID_CREDENTIALS, message: 'Email or password is incorrect.' }, { status: 423, code: ERROR_CODES.ACCOUNT_LOCKED, message: 'Too many failed attempts — the account is temporarily locked.' }, { status: 403, code: ERROR_CODES.PASSWORD_LOGIN_DISABLED, message: 'AUTH_MODE=production — sign in with Google instead (B-25).' }, apiError.rateLimited('Login is limited to 5 attempts per minute per IP (TZ §6.5).')] })
  login(@Body(zodBody(LoginDto)) dto: LoginDto, @Req() req: Request) {
    return this.auth.loginUser(dto.email, dto.password, AuthService.meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login/driver')
  @ApiOperation({
    summary: 'Driver password login (TZ §6.1).',
    description: 'D-130 — when the driver already has an assigned unit, the server writes the §395 Appendix A 4.5.1.5 login record (eventType 5, code 1) on it (idempotent).',
  })
  @ApiEnvelopeResponse(DriverLoginResponse, {
    status: 201,
    description: 'MB-9 — `driverId` is additive so the mobile app can name its per-driver offline DB file.',
    example: { accessToken: 'eyJ...', refreshToken: 'a1b2...', tokenType: 'Bearer', driverId: 'drv_1' },
  })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.INVALID_CREDENTIALS, message: 'Username or password is incorrect.' }, apiError.rateLimited()] })
  loginDriver(@Body(zodBody(DriverLoginDto)) dto: DriverLoginDto, @Req() req: Request) {
    return this.auth.loginDriver(dto.username, dto.password, AuthService.meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('google')
  @ApiOperation({
    summary: 'Google Sign-In via Firebase (TZ §6.2). No auto-registration.',
  })
  @ApiOkResponse({
    schema: { example: { accessToken: 'eyJ...', refreshToken: 'a1b2...', tokenType: 'Bearer' } },
  })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'The Firebase ID token could not be verified.' }, { status: 403, code: ERROR_CODES.USER_NOT_INVITED, message: 'Google Sign-In never auto-registers — the user must be invited first (TZ §6.2).' }] })
  google(@Body(zodBody(GoogleLoginDto)) dto: GoogleLoginDto, @Req() req: Request) {
    return this.auth.loginGoogle(dto.idToken, AuthService.meta(req));
  }

  @Public()
  // MB-20: web polls this every ~14 min (access TTL 15 min) and mobile at most once per 24h
  // (access TTL 24h), so one legitimate caller needs well under 1 req/min; 30/min/IP gives
  // headroom for several sessions behind one NAT/proxy while still capping brute-force guessing
  // of opaque refresh tokens (TZ §6.5).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @ApiOperation({ summary: 'Rotates a refresh token (TZ §6.5 — rotated on every use).' })
  @ApiEnvelopeResponse(TokenPairResponse, { status: 201, example: { accessToken: 'eyJ...', refreshToken: 'a1b2...', tokenType: 'Bearer' } })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.REFRESH_TOKEN_REUSED, message: 'This refresh token was already rotated — the whole session family is revoked (TZ §6.5).' }, apiError.rateLimited('Refresh is limited to 30 requests per minute per IP.')] })
  refresh(@Body(zodBody(RefreshTokenDto)) dto: RefreshTokenDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, dto.subjectType, AuthService.meta(req));
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revokes the session behind the given refresh token.',
    description: 'D-130 — for a driver it also writes the §395 Appendix A 4.5.1.5 logout record (eventType 5, code 2) for the open ELD login, if any.',
  })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors()
  async logout(@Body(zodBody(LogoutDto)) dto: LogoutDto, @CurrentUser() actor: ContextUser) {
    // Same subject mapping as before (an api-key principal never had a refresh session either).
    await this.auth.logout(actor.type as 'user' | 'driver', dto.refreshToken, actor.type === 'driver' ? actor.id : undefined);
    return { success: true };
  }

  @Public()
  @Post('password/forgot')
  @ApiOperation({ summary: 'Requests a password reset token. Always 200 (no user enumeration).' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ public: true, errors: [apiError.rateLimited()] })
  async forgotPassword(@Body(zodBody(ForgotPasswordDto)) dto: ForgotPasswordDto) {
    const result = await this.auth.forgotPassword(dto.email);
    return { success: true, ...result };
  }

  @Public()
  @Post('password/reset')
  @ApiOperation({ summary: 'Completes a password reset with the token from /auth/password/forgot.' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.TOKEN_EXPIRED, message: 'The reset link has expired — request a new one.' }] })
  async resetPassword(@Body(zodBody(ResetPasswordDto)) dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return { success: true };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/reset-code')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Web "Forgot password?" step 1 — emails a 6-digit code to an ACTIVE back-office user.',
    description:
      'Back-office `User` accounts only (drivers use `/auth/driver/password/*`). Unknown, INVITED or DISABLED email → 404 ' +
      '(the product shows "No account found with this email"). The code is stored as an HMAC, expires in 15 minutes, ' +
      'allows 5 wrong guesses and replaces any earlier code. Calling again within 60 s → 429 with `details.retryAfterSec`. ' +
      'Refused with 403 PASSWORD_LOGIN_DISABLED when AUTH_MODE=production, exactly like `POST /auth/login`. ' +
      'Inside the `USER_EMAIL_CHANGE_HOLD_HOURS` hold after an email change no code is mailed: 409 EMAIL_CHANGE_ON_HOLD ' +
      '(`details.holdUntil`) and the org administrators get an in-app notice.',
  })
  @ApiEnvelopeResponse(PasswordResetCodeSentResponse, {
    description: 'Code emailed. `code` is present only with DEV_ECHO_SECRETS=true outside production.',
    example: { success: true, email: 'sarah.chen@universal-logistics.example', expiresInSec: 900, resendAfterSec: 60 },
  })
  @ApiStandardErrors({
    public: true,
    errors: [
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'No account found with this email.'),
      { status: 403, code: ERROR_CODES.PASSWORD_LOGIN_DISABLED, message: 'AUTH_MODE=production — password sign-in (and reset) is off; use Google.' },
      apiError.conflict(
        ERROR_CODES.EMAIL_CHANGE_ON_HOLD,
        'The email on this account was changed recently, so a reset code cannot be emailed yet. Your administrator has been notified.',
      ),
      { status: 503, code: ERROR_CODES.SERVICE_UNAVAILABLE, message: "We couldn't send the email right now." },
      apiError.rateLimited('5 requests per minute per IP, and one code per account per 60 s (`details.retryAfterSec`).'),
    ],
  })
  requestPasswordResetCode(@Body(zodBody(RequestPasswordResetCodeDto)) dto: RequestPasswordResetCodeDto, @Req() req: Request) {
    return this.resetCodes.requestCode(dto.email, AuthService.meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('password/reset-code/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Web "Forgot password?" step 2 — verifies the emailed code and sets the new password.',
    description:
      'On success the code is consumed, the password is re-hashed (Argon2id) and every refresh session of the user is revoked. ' +
      'Wrong code → 422 RESET_CODE_INVALID (`details.code`, `details.attemptsRemaining`); expired / used / locked after 5 wrong ' +
      'guesses → 422 RESET_CODE_EXPIRED. Password policy: 8–128 characters (422 VALIDATION_FAILED).',
  })
  @ApiEnvelopeResponse(PasswordResetCompletedResponse, { description: 'Password changed.', example: { success: true } })
  @ApiStandardErrors({
    public: true,
    errors: [
      // One spec per status (Nest overwrites same-status responses): RESET_CODE_EXPIRED and
      // VALIDATION_FAILED share this 422 and are spelled out in the operation description.
      { status: 422, code: ERROR_CODES.RESET_CODE_INVALID, message: 'Incorrect code. 4 attempts left.' },
      { status: 403, code: ERROR_CODES.PASSWORD_LOGIN_DISABLED, message: 'AUTH_MODE=production — password sign-in (and reset) is off; use Google.' },
      apiError.rateLimited('10 requests per minute per IP.'),
    ],
  })
  async confirmPasswordResetCode(@Body(zodBody(ConfirmPasswordResetCodeDto)) dto: ConfirmPasswordResetCodeDto, @Req() req: Request) {
    await this.resetCodes.resetWithCode(dto.email, dto.code, dto.newPassword, AuthService.meta(req));
    return { success: true as const };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('driver/password/forgot')
  @HttpCode(200)
  @ApiOperation({ summary: 'MR-31/MB-16/MB-17 — driver requests a password-reset code by username or email. Always 200 (no user enumeration).',
    description: 'With an email on file a 6-digit numeric code is emailed: valid 15 minutes, invalidated after 5 wrong attempts, and a new request invalidates the previous code. Without an email the carrier ADMINs get an in-app notification ("driver X requested a password reset") and reset the password from the driver profile; the response is identical. Limited to 5 requests/min/IP.',
  })
  @ApiBody({ schema: { example: { username: 'johnsmith' } } })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ public: true, errors: [apiError.rateLimited('Limited to 5 requests per minute per IP.')] })
  async forgotDriverPassword(@Body(zodBody(DriverForgotPasswordDto)) dto: DriverForgotPasswordDto) {
    const result = await this.auth.forgotDriverPassword((dto.username ?? dto.email) as string);
    return { success: true, ...result };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('driver/password/reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'MR-31/MB-17 — completes a driver password reset with the emailed 6-digit code; revokes all driver sessions.',
    description: 'Send `{username|email, code, newPassword}`. The code is valid 15 minutes, single use, and is invalidated after 5 wrong attempts (request a new one via /auth/driver/password/forgot). The legacy `{token, newPassword}` form is still accepted. Every failure returns the same 401 TOKEN_INVALID.',
  })
  @ApiBody({ schema: { oneOf: [{ example: { username: 'johnsmith', code: '482913', newPassword: 'NewPassw0rd!' } }, { example: { token: 'eyJ...', newPassword: 'NewPassw0rd!' } }] } })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'The code is invalid, already used or expired.' }, apiError.rateLimited()] })
  async resetDriverPassword(@Body(zodBody(DriverResetPasswordDto)) dto: DriverResetPasswordDto) {
    if (dto.token) await this.auth.resetDriverPassword(dto.token, dto.newPassword);
    else await this.auth.resetDriverPasswordWithCode((dto.username ?? dto.email) as string, dto.code as string, dto.newPassword);
    return { success: true };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The authenticated principal (TZ §6.3 token claims), plus B-34 topbar fields for a `user` subject.',
    description: 'A `driver` subject additionally gets `username` (the ELD username, Appendix A 7.38), `fullName`, `email`, `homeTerminalTimezone`.',
  })
  @ApiEnvelopeResponse(MeResponse, {
    description: 'Example: a driver subject. A user subject instead carries `role`, `permissions`, `sessionId`, `fullName`, `email`, `avatarUrl`, `carrierName`, `homeTerminalTimezone`.',
    example: { id: 'drv_1', type: 'driver', username: 'johnsmith', fullName: 'John Smith', email: 'john@example.com', homeTerminalTimezone: 'America/New_York' },
  })
  @FigmaScreen('web/my-profile')
  @ApiStandardErrors()
  me(@CurrentUser() user: ContextUser) {
    return this.auth.meProfile(user);
  }
}
