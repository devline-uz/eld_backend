import { z } from 'zod';

/**
 * TZ §16 — the seven integration surfaces named in the TZ: TMS (McLeod), fuel card
 * (WEX/Comdata), QuickBooks, Slack, plus the generic outbound `webhook` provider (HMAC-signed
 * deliveries to a customer-owned endpoint). `Integration.provider` is `@unique` in the schema,
 * so this is a one-row-per-provider model — a fleet has at most one McLeod connection, one
 * generic webhook endpoint, etc.
 */
export const INTEGRATION_PROVIDERS = ['mcleod', 'wex', 'comdata', 'quickbooks', 'slack', 'webhook'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const UpsertIntegrationDto = z.object({
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type UpsertIntegrationDto = z.infer<typeof UpsertIntegrationDto>;
