import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Swagger response classes (D-131) for the auth routes the driver app calls — mirror `auth.service.ts`. */
export class TokenPairResponse {
  @ApiProperty({ type: String, example: 'eyJhbGciOi...' }) accessToken!: string;
  @ApiProperty({ type: String, example: 'a1b2c3...' }) refreshToken!: string;
  @ApiProperty({ type: String, enum: ['Bearer'] }) tokenType!: 'Bearer';
}

/** `POST /auth/login/driver` — MB-9: `driverId` names the app's per-driver offline DB file. */
export class DriverLoginResponse extends TokenPairResponse {
  @ApiProperty({ type: String }) driverId!: string;
}

/**
 * `GET /auth/me` — the token principal plus subject-specific profile fields. A `driver` subject
 * gets `username`/`fullName`/`email`/`homeTerminalTimezone`; a `user` subject gets
 * `fullName`/`email`/`avatarUrl`/`carrierName`/`homeTerminalTimezone`. Profile fields are absent
 * (not null) when the subject row cannot be loaded.
 */
export class MeResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, enum: ['user', 'driver', 'api-key'], enumName: 'PrincipalType' }) type!: 'user' | 'driver' | 'api-key';
  @ApiPropertyOptional({ type: String, description: 'Role key (user subjects).' }) role?: string;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', enum: ['NONE', 'READ', 'FULL'] },
    description: 'Permission matrix key -> level (user subjects).',
  })
  permissions?: Record<string, 'NONE' | 'READ' | 'FULL'>;
  @ApiPropertyOptional({ type: String, description: 'B-50 — session id behind a user access token.' }) sessionId?: string;
  @ApiPropertyOptional({ type: String, description: 'Driver only — the ELD username (Appendix A 7.38).' }) username?: string;
  @ApiPropertyOptional({ type: String }) fullName?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) email?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'User only.' }) avatarUrl?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'User only.' }) carrierName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Driver: home terminal zone; user: carrier zone.' }) homeTerminalTimezone?: string | null;
  @ApiPropertyOptional({
    type: Boolean,
    description: 'User only (F3-11) — whether the company profile has a compliance email (alert email destination); readable without `carrierSettings`.',
  })
  hasComplianceEmail?: boolean;
}

/** `POST /auth/password/reset-code` — web "Forgot password?" step 1. */
export class PasswordResetCodeSentResponse {
  @ApiProperty({ type: Boolean, enum: [true] }) success!: true;
  @ApiProperty({ type: String, description: 'The account email as stored (send it back on confirm).' }) email!: string;
  @ApiProperty({ type: Number, description: 'Seconds until the emailed code expires (900).' }) expiresInSec!: number;
  @ApiProperty({ type: Number, description: 'Seconds before "Resend code" is accepted (60).' }) resendAfterSec!: number;
  @ApiPropertyOptional({ type: String, description: 'The code itself — only with DEV_ECHO_SECRETS=true outside NODE_ENV=production.' })
  code?: string;
}

/** `POST /auth/password/reset-code/confirm` — web "Forgot password?" step 2. */
export class PasswordResetCompletedResponse {
  @ApiProperty({ type: Boolean, enum: [true] }) success!: true;
}
