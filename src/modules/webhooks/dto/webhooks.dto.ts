import { z } from 'zod';

export const SendTestWebhookDto = z.object({
  eventType: z.string().min(1).default('test.ping'),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type SendTestWebhookDto = z.infer<typeof SendTestWebhookDto>;
