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

/**
 * QA 2026-09-27 — `PUT /integrations/:provider` with `{ enabled: true, config: {} }` used to mark
 * McLeod/WEX/QuickBooks/Slack CONNECTED with no credentials at all. These are the config keys a
 * provider needs before it may be stored as CONNECTED (checked in `IntegrationsService.upsert`,
 * 422 `VALIDATION_FAILED` with one `config.<key>` issue per missing/invalid field). No provider
 * connector calls the real vendor API yet, so the set is the minimal credential shape per vendor.
 * Providers without an entry (Pacific Track, DAT, Geotab, Zapier) have no defined credentials yet.
 */
export interface IntegrationConfigField {
  key: string;
  label: string;
  /** `https` — must be an absolute https:// URL; `slack-webhook` — https://hooks.slack.com/… */
  format?: 'https' | 'slack-webhook';
}

export const INTEGRATION_REQUIRED_CONFIG: Partial<Record<IntegrationProvider, readonly IntegrationConfigField[]>> = {
  mcleod: [
    { key: 'baseUrl', label: 'API base URL', format: 'https' },
    { key: 'username', label: 'Username' },
    { key: 'apiKey', label: 'API key' },
  ],
  wex: [
    { key: 'accountNumber', label: 'Account number' },
    { key: 'apiKey', label: 'API key' },
  ],
  comdata: [
    { key: 'accountNumber', label: 'Account number' },
    { key: 'apiKey', label: 'API key' },
  ],
  quickbooks: [
    { key: 'realmId', label: 'Company (realm) ID' },
    { key: 'clientId', label: 'Client ID' },
    { key: 'clientSecret', label: 'Client secret' },
  ],
  slack: [{ key: 'webhookUrl', label: 'Incoming webhook URL', format: 'slack-webhook' }],
  webhook: [
    { key: 'url', label: 'Endpoint URL' },
    { key: 'secret', label: 'Signing secret' },
  ],
};

/** Returns one `{ path, code, message }` issue per required config field that is missing, blank
 * or badly formatted — the same issue shape `ZodValidationPipe` emits, so the web form maps it. */
export function validateIntegrationConfig(
  provider: string,
  config: Record<string, unknown>,
): { path: string; code: string; message: string }[] {
  const fields = INTEGRATION_REQUIRED_CONFIG[provider as IntegrationProvider] ?? [];
  const issues: { path: string; code: string; message: string }[] = [];
  for (const field of fields) {
    const value = config[field.key];
    const path = `config.${field.key}`;
    if (typeof value !== 'string' || value.trim().length === 0) {
      issues.push({ path, code: 'required', message: `${field.label} is required.` });
      continue;
    }
    if (field.format === 'https' && !isHttpsUrl(value)) {
      issues.push({ path, code: 'invalid_string', message: `${field.label} must be a full https:// URL.` });
    } else if (field.format === 'slack-webhook' && !isSlackWebhookUrl(value)) {
      issues.push({ path, code: 'invalid_string', message: `${field.label} must start with https://hooks.slack.com/.` });
    }
  }
  return issues;
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isSlackWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.pathname.length > 1;
  } catch {
    return false;
  }
}
