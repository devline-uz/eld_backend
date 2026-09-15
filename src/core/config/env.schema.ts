import { z } from 'zod';

const bool = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('api'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  // --- database (TZ §22.3) -------------------------------------------------
  DATABASE_URL: z.string().url(),
  /** TZ §5.5/§18/§23 — connection string for the narrowly-scoped `eld_retention_svc` role
   * (SELECT+DELETE on `AuditLog` only, bootstrapped by
   * `scripts/bootstrap-retention-role.sql`). Deliberately NOT `DATABASE_URL`: the app role
   * has DELETE revoked on `AuditLog` (B-009) and must never get it back. Optional — when
   * unset, `retention.processor` still archives+drops `EldEvent` partitions but skips the
   * `AuditLog` purge step (logs a warning) rather than falling back to the app role. */
  RETENTION_DATABASE_URL: z.string().url().optional(),

  // --- redis / BullMQ ------------------------------------------------------
  REDIS_URL: z.string().url(),
  /** TZ §22.3.4: dev uses Redis DB 1, prod DB 0. */
  REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
  QUEUE_PREFIX: z.string().default('onebook'),

  // --- storage (TZ §17) ----------------------------------------------------
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('onebook-eld'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool('true'),
  /** TZ §27.1 point 5 — object keys are prefixed so a tenant prefix can be added later. */
  S3_KEY_PREFIX: z.string().default(''),
  S3_PRESIGN_TTL_SEC: z.coerce.number().int().positive().default(900),

  // --- auth (TZ §6) --------------------------------------------------------
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-32-characters'),
  /** User (back-office) tokens — TZ §6.1: access 15 min / refresh 30 days. */
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  /** Driver (mobile) tokens — TZ §6.1: access 24h / refresh 90 days. */
  JWT_DRIVER_ACCESS_TTL: z.string().default('24h'),
  JWT_DRIVER_REFRESH_TTL: z.string().default('90d'),
  /** Short-lived token for the `/auth/password/reset` flow. */
  JWT_PASSWORD_RESET_TTL: z.string().default('30m'),
  FIREBASE_PROJECT_ID: z.string().optional(),
  /** Path to the service-account JSON — never committed (TZ §6.5). */
  FIREBASE_CREDENTIALS_FILE: z.string().optional(),

  // --- integrations (TZ §16) ------------------------------------------------
  /** Base64-encoded 32-byte AES-256-GCM key that encrypts `Integration.config` secrets at
   * rest. Prod value lives in the server secrets folder (this project's `.env`, not
   * committed — same place as POSTGRES/REDIS/MINIO passwords); this default is dev-only,
   * same convention as JWT_SECRET's dev default above. */
  INTEGRATION_ENCRYPTION_KEY: z.string().default('ZGV2LW9ubHktMzItYnl0ZS1rZXktY2hhbmdlLW1lISE='),

  // --- eRODS transfer (TZ §10) ---------------------------------------------
  /**
   * FMCSA's public key for §10.4 email encryption — PEM or base64-encoded PEM, kept in the
   * server secrets folder. OPEN (tasks.md #3): FMCSA has not given us the key, so this is
   * unset and `FmcsaEncryptionService.configured` is false; TEST mode does not need it.
   */
  FMCSA_PUBLIC_KEY: z.string().optional(),
  /**
   * OPEN (tasks.md #3): FMCSA's mandated subject-line format. Template, not code —
   * placeholders `{fileName}` and `{comment}`.
   */
  FMCSA_EMAIL_SUBJECT_TEMPLATE: z.string().default('ELD Output File: {fileName}'),
  /** Web-services endpoint used only when `Carrier.erodsMode = PRODUCTION`. */
  FMCSA_WEB_SERVICES_URL: z.string().url().optional(),
  /** Default recipient offered in the UI; still re-checked against `*.fmcsa.dot.gov`. */
  FMCSA_TRANSFER_EMAIL: z.string().default('eldsubmissions@fmcsa.dot.gov'),

  // --- observability (TZ §22.5) -------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: bool('false'),
  SENTRY_DSN: z.string().optional(),
  /** TZ §22.5 — separate Sentry projects for dev and prod; defaults to NODE_ENV when unset. */
  SENTRY_ENVIRONMENT: z.string().optional(),
  METRICS_ENABLED: bool('true'),
  /** Worker container has no HTTP stack of its own (§3.3) — this is its own health/metrics
   * listener, separate from the API's PORT, so both containers can be probed independently. */
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3002),

  // --- misc ----------------------------------------------------------------
  SEED_ANCHOR_DATE: z.string().optional(),
  SWAGGER_ENABLED: bool('true'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
});

export type AppEnv = z.infer<typeof envSchema>;

/** Parses process.env, aggregating every problem into one readable failure. */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
