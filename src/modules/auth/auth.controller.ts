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
import { DriverLoginResponse, MeResponse, TokenPairResponse } from './dto/auth.responses';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import {
  DriverLoginDto,
  DriverForgotPasswordDto,
  ForgotPasswordDto,
  GoogleLoginDto,
  LoginDto,
  LogoutDto,
  RefreshTokenDto,
  ResetPasswordDto,
  VerifyEmailChangeDto,
} from './dto/auth.dto';

/** TZ §11.1 — auth endpoint list. Every rule lives in AuthService; this stays thin. */
@FigmaScreen('web/sign-in')
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
  @Post('driver/password/forgot')
  @HttpCode(200)
  @ApiOperation({ summary: 'MR-31 — driver requests a password-reset code by username or email. Always 200 (no user enumeration); the code is emailed when the driver has an email on file.' })
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
  @ApiOperation({ summary: 'MR-31 — completes a driver password reset with the emailed code; revokes all driver sessions.' })
  @ApiBody({ schema: { example: { token: 'eyJ...', newPassword: 'NewPassw0rd!' } } })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'The code is invalid, already used or expired.' }, apiError.rateLimited()] })
  async resetDriverPassword(@Body(zodBody(ResetPasswordDto)) dto: ResetPasswordDto) {
    await this.auth.resetDriverPassword(dto.token, dto.newPassword);
    return { success: true };
  }

  @Public()
  @Post('email/verify')
  @ApiOperation({ summary: 'B-84 — completes a `PATCH /users/:id { email }` re-verification.' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.TOKEN_INVALID, message: 'The verification link is invalid or expired.' }, apiError.conflict(ERROR_CODES.CONFLICT, 'Another user already has this email.')] })
  async verifyEmailChange(@Body(zodBody(VerifyEmailChangeDto)) dto: VerifyEmailChangeDto) {
    await this.auth.verifyEmailChange(dto.token);
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
