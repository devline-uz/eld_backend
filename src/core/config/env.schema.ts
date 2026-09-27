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
  /** B-25 — `production` blocks `POST /auth/login` (password login) with
   * `403 PASSWORD_LOGIN_DISABLED`, forcing Google Sign-In for the back office. Defaults to
   * `dev` so seeded password logins (and driver login, which this never touches) keep
   * working unless an operator explicitly opts a deployment into `production`. */
  AUTH_MODE: z.enum(['dev', 'production']).default('dev'),
  /** B-093 — echo one-time secrets (password-reset / email-verify tokens, driver one-time
   * codes that were also emailed) in API responses so flows are testable without a mailer.
   * Off unless explicitly enabled, and ignored when NODE_ENV=production: the public dev API
   * runs with NODE_ENV=development, and "not production" alone handed any caller of the
   * unauthenticated `POST /auth/password/forgot` a live reset token. */
  DEV_ECHO_SECRETS: bool('false'),

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
  /** Bind address for the worker's bare-http health/metrics listener; default keeps
   * prior behaviour (all interfaces) but ops can pin it to loopback behind a proxy. */
  WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),

  // --- mobile app update (TZ §11.8 bootstrap.appUpdate, MB-19) --------------
  /** Unset in dev/most envs — `bootstrap.appUpdate` is then `null` rather than a half-filled
   * object, so the app never shows a stale "update available" banner off defaults. */
  MOBILE_APP_LATEST_VERSION: z.string().optional(),
  MOBILE_APP_MIN_VERSION: z.string().optional(),
  MOBILE_APP_RELEASE_NOTES: z.string().optional(),
  MOBILE_APP_STORE_URL_IOS: z.string().optional(),
  MOBILE_APP_STORE_URL_ANDROID: z.string().optional(),

  // --- geocoding (TZ §20 B-93) ----------------------------------------------
  /** Nominatim-compatible `/search?q=&format=json` base URL for `type: 'ADDRESS'` geofences.
   * Unset by default — no paid geocoding vendor is wired in, so `POST/PATCH /geofences` with
   * an `ADDRESS` type returns `422 GEOCODER_NOT_CONFIGURED` until an operator points this at
   * a self-hosted or public Nominatim instance (decisions.md). */
  GEOCODER_URL: z.string().url().optional(),

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
