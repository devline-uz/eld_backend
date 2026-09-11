import { SetMetadata } from '@nestjs/common';

export const TWO_FACTOR_EXEMPT_KEY = 'onebook:two-factor-exempt';

/**
 * TZ §6.2 — "ADMIN without 2FA may only reach /me/security". Marks the handful of
 * self-service endpoints (login/2FA setup, `/me/*`) an ADMIN must be able to reach before
 * TOTP is configured. Everything else is blocked by `TwoFactorSetupGuard`.
 */
export const TwoFactorExempt = () => SetMetadata(TWO_FACTOR_EXEMPT_KEY, true);
