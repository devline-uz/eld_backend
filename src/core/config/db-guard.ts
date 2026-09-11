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
export const PROD_DB_USER = 'eld_prod';

export function assertDatabaseTarget(config: Pick<AppEnv, 'DATABASE_URL' | 'NODE_ENV'>): void {
  const url = new URL(config.DATABASE_URL);
  const db = url.pathname.slice(1);
  const isProdDb = db === PROD_DB_NAME;
  const isDevDb = db === DEV_DB_NAME;
  const isProdEnv = config.NODE_ENV === 'production';

  if (!isProdDb && !isDevDb) throw new Error(`XAVFLI: noma'lum DB nomi "${db}"`);
  if (!isProdEnv && isProdDb) throw new Error('XAVFLI: dev rejimi PROD DB ga ulanmoqda!');
  if (isProdEnv && isDevDb) throw new Error('XAVFLI: prod rejimi DEV DB ga ulanmoqda!');
  if (isProdEnv && url.username !== PROD_DB_USER)
    throw new Error("XAVFLI: prod noto'g'ri DB foydalanuvchisi bilan ulanmoqda!");
}
