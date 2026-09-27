/**
 * Jest setup for the `integration` project (tz.md §21 — "Integration — repository —
 * asosiy so'rovlar — dev DB (22.3)"). Loads `.env.test` (D-105, Phase 13J follow-up) so
 * `npm run test:integration` targets the dedicated `onebook_eld_test` DB/`eld_test` role —
 * NEVER the live `onebook_eld_dev` that the mock simulator and pm2 `eld-api`/`eld-worker`
 * are continuously reading/writing — without requiring the caller to `source` the file
 * manually. Hard-fails if DATABASE_URL is ever pointed at anything else (dev OR prod); these
 * tests run destructive-looking DDL/DML checks (partition routing, REVOKE enforcement,
 * row-count assertions) that must never touch a database anything else depends on.
 */
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../../.env.test'), override: true });
// Belt-and-suspenders with src/core/config/db-guard.ts's isTestEnv/isTestDb pairing (D-105):
// Jest sets this implicitly too, but AppConfigService must see exactly 'test' regardless of
// how the process was launched.
process.env.NODE_ENV = 'test';

const url = new URL(process.env.DATABASE_URL ?? '');
const dbName = url.pathname.replace(/^\//, '');

if (dbName !== 'onebook_eld_test') {
  throw new Error(
    `test:integration refuses to run — DATABASE_URL points at "${dbName}", expected "onebook_eld_test" ` +
      '(D-105 — integration/e2e must never touch onebook_eld_dev or onebook_eld).',
  );
}
