import { z } from 'zod';

/** TZ §14 / MB-1 — `POST /mobile/push-tokens`. */
export const RegisterPushTokenDto = z.object({
  token: z.string().min(8).max(4096),
  platform: z.enum(['IOS', 'ANDROID']),
  deviceLabel: z.string().max(200).optional(),
});
export type RegisterPushTokenDto = z.infer<typeof RegisterPushTokenDto>;
