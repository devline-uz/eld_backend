/**
 * OneBook ELD — mock-data orchestrator (see prisma/mock/README.md).
 *
 * Usage:
 *   npm run db:mock                 -> runs every generator, in the fixed order below
 *   npm run db:mock -- core hos     -> runs only the named generators, in the fixed pipeline
 *                                      order (not the CLI order)
 *   npm run db:mock -- ingest       -> runs `ingest` alone; allowed as long as the mock core
 *                                      rows already exist in the DB (checked below, NOT by
 *                                      requiring "core" on the same command line — see D-055)
 *
 * Loads `.env.development` explicitly (this script is invoked directly with ts-node, outside
 * the Prisma CLI, so nothing else loads it) and hard-refuses to run against any DB other than
 * `onebook_eld_dev`.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env.development') });

import { PrismaClient } from '@prisma/client';
import { buildContext, MockContext, MOCK_USERNAME_PREFIX, MOCK_UNIT_PREFIX, MOCK_DEVICE_PREFIX } from './context';

const ORDER = ['core', 'users', 'hos', 'ingest', 'compliance', 'fleet', 'safety-comms', 'reports'] as const;
type GeneratorName = (typeof ORDER)[number];

const DEV_DB_NAME = 'onebook_eld_dev';

function assertDevDb(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error('db:mock: DATABASE_URL is not set (expected it from .env.development).');
  }
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (dbName !== DEV_DB_NAME) {
    throw new Error(
      `db:mock: refusing to run — DATABASE_URL points at "${dbName}", expected exactly "${DEV_DB_NAME}".`,
    );
  }
}

/**
 * DB-based guard, not a CLI-argument guard (D-055 fix, 2026-09-14): a non-core generator may run
 * alone as long as the mock core rows it depends on already exist — checked directly, so
 * `npm run db:mock -- ingest` never has to also re-run `core` just to pass this check. Re-running
 * `core` unnecessarily used to delete+recreate every mock driver/vehicle/device with fresh
 * random ids, orphaning every row another generator had already written against the old ids.
 */
async function assertCoreExists(prisma: PrismaClient): Promise<void> {
  const [drivers, vehicles, devices] = await Promise.all([
    prisma.driver.count({ where: { username: { startsWith: MOCK_USERNAME_PREFIX } } }),
    prisma.vehicle.count({ where: { unitNumber: { startsWith: MOCK_UNIT_PREFIX } } }),
    prisma.device.count({ where: { serial: { startsWith: MOCK_DEVICE_PREFIX } } }),
  ]);
  if (drivers === 0 || vehicles === 0 || devices === 0) {
    throw new Error(
      'db:mock: mock core rows not found (mock_* drivers / M1... vehicles / MOCKPT30-* devices) — ' +
        'run `npm run db:mock -- core` first, then re-run this generator.',
    );
  }
}

async function loadGenerator(name: GeneratorName): Promise<{ run(ctx: MockContext): Promise<Record<string, number>> }> {
  const mod = (await import(`./generators/${name}`)) as { run(ctx: MockContext): Promise<Record<string, number>> };
  if (typeof mod.run !== 'function') {
    throw new Error(`db:mock: generators/${name}.ts does not export run()`);
  }
  return mod;
}

async function main(): Promise<void> {
  assertDevDb(process.env.DATABASE_URL);

  const requested = process.argv.slice(2).filter(Boolean);
  const names: GeneratorName[] =
    requested.length > 0
      ? (requested as GeneratorName[])
      : [...ORDER];

  for (const n of names) {
    if (!ORDER.includes(n)) {
      throw new Error(`db:mock: unknown generator "${n}" — expected one of ${ORDER.join(', ')}`);
    }
  }

  // Always execute in the fixed pipeline order, regardless of CLI argument order.
  const ordered = ORDER.filter((n) => names.includes(n));

  const prisma = new PrismaClient();
  try {
    // Fixed dependency: nothing may run before the mock core rows exist (the fleet/driver/
    // vehicle base rows every other domain's FKs point at). Checked against the DB, not the CLI
    // argument list, so a lone `npm run db:mock -- ingest` never has to drag `core` along just
    // to satisfy this guard (see the doc comment on `assertCoreExists` / D-055).
    if (!names.includes('core')) {
      await assertCoreExists(prisma);
    }

    const ctx = await buildContext(prisma, (msg: string) => console.log(`[db:mock] ${msg}`));
    console.log(
      `[db:mock] target=onebook_eld_dev carrierId=${ctx.carrierId} window=${ctx.from.toISOString()}..${ctx.to.toISOString()}`,
    );
    for (const name of ordered) {
      const gen = await loadGenerator(name);
      const startedAt = Date.now();
      const counts = await gen.run(ctx);
      const ms = Date.now() - startedAt;
      const summary = Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(`[db:mock] ${name}: ${summary || '(no rows)'} — ${ms}ms`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
