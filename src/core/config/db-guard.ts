import { AppEnv } from './env.schema';

/**
 * TZ §22.3 point 4 — two-way connection protection.
 *
 * ⚠️ This check is NOT disableable and has no escape hatch env flag. It runs at
 * AppModule bootstrap (API and worker alike). Both directions are covered:
 * dev must never touch the prod DB, and prod must never touch the dev DB.
 */
export const PROD_DB_NAME = 'onebook_eld';
export const DEV_DB_NAME = 'onebook_eld_dev';
// D-105 — dedicated integration/e2e DB (Phase 13J follow-up), isolated from DEV_DB_NAME so
// test runs never share rows/connections with the live mock simulator + pm2 api/worker.
// Only ever a valid target when NODE_ENV === 'test' (test/setup/*.setup.ts sets this) — this
// is a named allowlist entry, not a bypass: it still rejects the prod DB, still rejects the
// dev DB in a test process, and still rejects the test DB from a non-test process.
export const TEST_DB_NAME = 'onebook_eld_test';
export const PROD_DB_USER = 'eld_prod';

export function assertDatabaseTarget(config: Pick<AppEnv, 'DATABASE_URL' | 'NODE_ENV'>): void {
  const url = new URL(config.DATABASE_URL);
  const db = url.pathname.slice(1);
  const isProdDb = db === PROD_DB_NAME;
  const isDevDb = db === DEV_DB_NAME;
  const isTestDb = db === TEST_DB_NAME;
  const isProdEnv = config.NODE_ENV === 'production';
  const isTestEnv = config.NODE_ENV === 'test';

  if (!isProdDb && !isDevDb && !isTestDb) throw new Error(`XAVFLI: noma'lum DB nomi "${db}"`);
  if (!isProdEnv && isProdDb) throw new Error('XAVFLI: dev rejimi PROD DB ga ulanmoqda!');
  if (isProdEnv && isDevDb) throw new Error('XAVFLI: prod rejimi DEV DB ga ulanmoqda!');
  if (isProdEnv && isTestDb) throw new Error('XAVFLI: prod rejimi TEST DB ga ulanmoqda!');
  if (isTestDb && !isTestEnv) throw new Error("XAVFLI: TEST DB faqat NODE_ENV=test bilan ishlatilishi mumkin!");
  if (isTestEnv && !isTestDb) throw new Error("XAVFLI: NODE_ENV=test faqat TEST DB bilan ishlatilishi mumkin!");
  if (isProdEnv && url.username !== PROD_DB_USER)
    throw new Error("XAVFLI: prod noto'g'ri DB foydalanuvchisi bilan ulanmoqda!");
}
