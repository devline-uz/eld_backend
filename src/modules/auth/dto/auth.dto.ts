import { z } from 'zod';

export const LoginDto = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginDto = z.infer<typeof LoginDto>;

export const DriverLoginDto = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type DriverLoginDto = z.infer<typeof DriverLoginDto>;

export const GoogleLoginDto = z.object({
  idToken: z.string().min(1),
});
export type GoogleLoginDto = z.infer<typeof GoogleLoginDto>;

export const RefreshTokenDto = z.object({
  refreshToken: z.string().min(1),
  subjectType: z.enum(['user', 'driver']),
});
export type RefreshTokenDto = z.infer<typeof RefreshTokenDto>;

export const LogoutDto = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutDto = z.infer<typeof LogoutDto>;

export const ForgotPasswordDto = z.object({
  email: z.string().email(),
});
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordDto>;

export const ResetPasswordDto = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordDto>;

/** B-84 — `PATCH /users/:id { email }` re-verification, `POST /auth/email/verify`. */
export const VerifyEmailChangeDto = z.object({
  token: z.string().min(1),
});
export type VerifyEmailChangeDto = z.infer<typeof VerifyEmailChangeDto>;

/** MR-31 — driver self-service reset; `username` or `email` (at least one). */
export const DriverForgotPasswordDto = z
  .object({ username: z.string().min(1).max(120).optional(), email: z.string().email().optional() })
  .refine((v) => Boolean(v.username || v.email), { message: 'username or email is required' });
export type DriverForgotPasswordDto = z.infer<typeof DriverForgotPasswordDto>;

/** Web "Forgot password?" — same rule as `ResetPasswordDto.newPassword` (min 8), capped so an
 * unauthenticated caller cannot make Argon2 hash megabytes. */
export const WebNewPassword = z.string().min(8, 'Password must be at least 8 characters.').max(128, 'Password must be at most 128 characters.');

/** `POST /auth/password/reset-code` — back-office `User` only (never a driver). */
export const RequestPasswordResetCodeDto = z.object({
  email: z.string().trim().email().max(254),
});
export type RequestPasswordResetCodeDto = z.infer<typeof RequestPasswordResetCodeDto>;

/** `POST /auth/password/reset-code/confirm`. */
export const ConfirmPasswordResetCodeDto = z.object({
  email: z.string().trim().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email.'),
  newPassword: WebNewPassword,
});
export type ConfirmPasswordResetCodeDto = z.infer<typeof ConfirmPasswordResetCodeDto>;
