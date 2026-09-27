import { z } from 'zod';

/**
 * TZ §16 — the integration surfaces named in the TZ: TMS (McLeod), fuel card (WEX/Comdata),
 * QuickBooks, Slack, the generic outbound `webhook` provider (HMAC-signed deliveries to a
 * customer-owned endpoint), plus the web W-22 marketplace entries Pacific Track (ELD hardware),
 * DAT (load board), Geotab (telematics) and Zapier — connected the same way as the rest: a
 * stored, secret-encrypted `config` per provider. `Integration.provider` is `@unique` in the schema,
 * so this is a one-row-per-provider model — a fleet has at most one McLeod connection, one
 * generic webhook endpoint, etc.
 */
export const INTEGRATION_PROVIDERS = [
  'mcleod',
  'wex',
  'comdata',
  'quickbooks',
  'slack',
  'webhook',
  'pacific-track',
  'dat',
  'geotab',
  'zapier',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const UpsertIntegrationDto = z.object({
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type UpsertIntegrationDto = z.infer<typeof UpsertIntegrationDto>;

/**
 * §20 B-89 `GET /integrations/catalog` — the marketplace listing (L1068/L1071): every
 * connectable `INTEGRATION_PROVIDERS` entry. Static — no DB row backs a catalog entry;
 * `available` stays in the shape so a future not-yet-built provider can be listed as `false`.
 */
export interface IntegrationCatalogEntry {
  provider: string;
  name: string;
  description: string;
  category: string;
  available: boolean;
}

export const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
  { provider: 'mcleod', name: 'McLeod', description: 'TMS load and dispatch sync.', category: 'TMS', available: true },
  { provider: 'wex', name: 'WEX', description: 'Fuel card transaction sync.', category: 'Fuel card', available: true },
  { provider: 'comdata', name: 'Comdata', description: 'Fuel card transaction sync.', category: 'Fuel card', available: true },
  { provider: 'quickbooks', name: 'QuickBooks', description: 'Accounting/invoicing sync.', category: 'Accounting', available: true },
  { provider: 'slack', name: 'Slack', description: 'Alert notifications to a Slack channel.', category: 'Notifications', available: true },
  { provider: 'webhook', name: 'Generic webhook', description: 'HMAC-signed outbound event delivery to your own endpoint.', category: 'Developer', available: true },
  { provider: 'pacific-track', name: 'Pacific Track', description: 'ELD hardware · PT30 / PT40.', category: 'ELD hardware', available: true },
  { provider: 'dat', name: 'DAT', description: 'Find and book available loads.', category: 'Load board', available: true },
  { provider: 'geotab', name: 'Geotab', description: 'Import telematics from mixed fleets.', category: 'Telematics', available: true },
  { provider: 'zapier', name: 'Zapier', description: 'Automate with 6,000+ apps.', category: 'Developer', available: true },
];
