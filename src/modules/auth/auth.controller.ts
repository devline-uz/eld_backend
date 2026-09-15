import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import {
  DriverLoginDto,
  ForgotPasswordDto,
  GoogleLoginDto,
  LoginDto,
  LogoutDto,
  RefreshTokenDto,
  ResetPasswordDto,
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
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.INVALID_CREDENTIALS, message: 'Email or password is incorrect.' }, { status: 423, code: ERROR_CODES.ACCOUNT_LOCKED, message: 'Too many failed attempts — the account is temporarily locked.' }, apiError.rateLimited('Login is limited to 5 attempts per minute per IP (TZ §6.5).')] })
  login(@Body(zodBody(LoginDto)) dto: LoginDto, @Req() req: Request) {
    return this.auth.loginUser(dto.email, dto.password, AuthService.meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login/driver')
  @ApiOperation({ summary: 'Driver password login (TZ §6.1).' })
  @ApiOkResponse({
    schema: { example: { accessToken: 'eyJ...', refreshToken: 'a1b2...', tokenType: 'Bearer' } },
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
  @Post('refresh')
  @ApiOperation({ summary: 'Rotates a refresh token (TZ §6.5 — rotated on every use).' })
  @ApiOkResponse({
    schema: { example: { accessToken: 'eyJ...', refreshToken: 'a1b2...', tokenType: 'Bearer' } },
  })
  @ApiStandardErrors({ public: true, errors: [{ status: 401, code: ERROR_CODES.REFRESH_TOKEN_REUSED, message: 'This refresh token was already rotated — the whole session family is revoked (TZ §6.5).' }] })
  refresh(@Body(zodBody(RefreshTokenDto)) dto: RefreshTokenDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, dto.subjectType, AuthService.meta(req));
  }

  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revokes the session behind the given refresh token.' })
  @ApiOkResponse({ schema: { example: { success: true } } })
  @ApiStandardErrors()
  async logout(@Body(zodBody(LogoutDto)) dto: LogoutDto, @CurrentUser('type') subjectType: 'user' | 'driver') {
    await this.auth.logout(subjectType, dto.refreshToken);
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

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated principal (TZ §6.3 token claims, minus signature).' })
  @ApiOkResponse({
    schema: { example: { id: 'usr_1', type: 'user', role: 'ADMIN', permissions: {} } },
  })
  @FigmaScreen('web/my-profile')
  @ApiStandardErrors()
  me(@CurrentUser() user: unknown) {
    return user;
  }
}
