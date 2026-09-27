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
