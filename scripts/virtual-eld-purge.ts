/**
 * `npm run virtual-eld:purge -- --before=<date> [--dry-run]` — pt30_pt40/tz.md §9.5.
 *
 * Dev only: refuses NODE_ENV=production, the prod DB, and VIRTUAL_ELD_ALLOWED=false. Deletes raw
 * events + telemetry and resets BLE state of VIRTUAL devices only; never RODS (`EldEvent`).
 * DATABASE_URL: an exported value wins, else `.env.development`.
 */
import { PrismaClient } from '@prisma/client';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfigService } from '../src/core/config/config.service';
import { assertDatabaseTarget, PROD_DB_NAME } from '../src/core/config/db-guard';
import { parseEnv } from '../src/core/config/env.schema';
import { parsePurgeArgs, purgeVirtualEldData } from '../src/modules/carrier/virtual-eld-purge';

function fail(message: string): never {
  console.error(`virtual-eld:purge: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const envFile = join(__dirname, '..', '.env.development');
  if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

  let args: ReturnType<typeof parsePurgeArgs>;
  try {
    args = parsePurgeArgs(process.argv.slice(2));
  } catch (err) {
    fail((err as Error).message);
  }

  const env = parseEnv();
  const config = new AppConfigService(env);
  if (config.isProduction) fail('refusing to run with NODE_ENV=production.');
  if (new URL(env.DATABASE_URL).pathname.slice(1) === PROD_DB_NAME) fail('DATABASE_URL points at the prod database.');
  assertDatabaseTarget(env);
  if (!config.virtualEldAllowed) fail('VIRTUAL_ELD_ALLOWED is false — nothing to purge here.');

  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const result = await purgeVirtualEldData(prisma, args.before, args.dryRun);
    console.log(
      `${result.dryRun ? '[dry-run] would purge' : 'purged'} before ${args.before.toISOString()}: ` +
        `${result.virtualDevices} virtual device(s), ${result.rawEvents} raw event(s), ` +
        `${result.telemetryPoints} telemetry point(s), ${result.bleStatesReset} BLE state(s) reset. RODS events untouched.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
