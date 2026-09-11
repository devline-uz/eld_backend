/**
 * Jest setup for the `integration` project (tz.md §21 — "Integration — repository —
 * asosiy so'rovlar — dev DB (22.3)"). Loads `.env.development` so `npm run
 * test:integration` targets the dev DB without requiring the caller to
 * `source` the file manually, and hard-fails if DATABASE_URL is ever pointed
 * at the prod database — these tests run destructive-looking DDL/DML checks
 * (partition routing, REVOKE enforcement) that must never touch prod.
 */
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../../.env.development'), override: false });

const url = new URL(process.env.DATABASE_URL ?? '');
const dbName = url.pathname.replace(/^\//, '');

if (dbName !== 'onebook_eld_dev') {
  throw new Error(
    `test:integration refuses to run — DATABASE_URL points at "${dbName}", expected "onebook_eld_dev".`,
  );
}
