/**
 * `npm run migrate:dev -- --name <change> [--create-only] [--dry-run]`
 *
 * `prisma migrate dev` replacement that can never drop the hand-written partial / expression
 * indexes listed in `src/core/prisma/custom-indexes.ts` (Prisma's schema language can't express
 * them, so a schema diff may propose DROPping them — see that file).
 *
 *  1. Refuses to run unless DATABASE_URL is a LOCAL dev database (localhost / 127.0.0.1 / ::1 /
 *     the docker-compose `postgres` host) and not the prod database name.
 *  2. Generates the next migration exactly like `migrate dev` does — migration history replayed
 *     into a shadow database, diffed against `prisma/schema.prisma` — via
 *     `prisma migrate diff --from-migrations --to-schema-datamodel --shadow-database-url`.
 *     The shadow DB is SHADOW_DATABASE_URL, or `<db>_shadow` on the same server (create it once:
 *     `createdb -O eld_dev onebook_eld_dev_shadow`). An explicit shadow URL is used instead of
 *     `migrate dev --create-only` because the dev role has no CREATEDB (P3014).
 *  3. Strips every DROP / CREATE INDEX of a custom index and prints what it removed.
 *  4. Nothing left -> writes nothing ("no schema changes"). Otherwise writes
 *     `prisma/migrations/<UTC timestamp>_<name>/migration.sql`, then (unless --create-only)
 *     applies it with `prisma migrate deploy` and runs `prisma generate`.
 *
 * `--dry-run` prints the stripped SQL and writes / applies nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripCustomIndexStatements } from '../src/core/prisma/custom-indexes';

const ROOT = join(__dirname, '..');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'host.docker.internal']);

function fail(message: string): never {
  console.error(`migrate:dev: ${message}`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function prisma(args: string[], capture: boolean): string {
  return execFileSync('npx', ['prisma', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

function main(): void {
  const dryRun = flag('dry-run');
  const createOnly = flag('create-only');
  const name = (arg('name') ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!dryRun && !name) fail('pass --name <change> (snake_case), or --dry-run.');

  // Same `.env` the Prisma CLI reads; an already-exported DATABASE_URL wins.
  if (!process.env.DATABASE_URL && existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
  if (process.env.NODE_ENV === 'production') fail('refusing to run with NODE_ENV=production.');
  const raw = process.env.DATABASE_URL;
  if (!raw) fail('DATABASE_URL is not set.');
  const dbUrl = new URL(raw);
  const dbName = dbUrl.pathname.replace(/^\//, '');
  if (!LOCAL_HOSTS.has(dbUrl.hostname)) fail(`DATABASE_URL host "${dbUrl.hostname}" is not a local dev database.`);
  if (dbName === 'onebook_eld') fail('DATABASE_URL points at the prod database name (onebook_eld).');

  const shadow = process.env.SHADOW_DATABASE_URL ?? (() => {
    const u = new URL(raw);
    u.pathname = `/${dbName}_shadow`;
    u.search = '';
    return u.toString();
  })();
  if (shadow.replace(/\?.*$/, '') === raw.replace(/\?.*$/, '')) fail('the shadow database must not be DATABASE_URL.');

  const generated = prisma(
    [
      'migrate', 'diff',
      '--from-migrations', 'prisma/migrations',
      '--to-schema-datamodel', 'prisma/schema.prisma',
      '--shadow-database-url', shadow,
      '--script',
    ],
    true,
  );
  const { sql, removed, empty } = stripCustomIndexStatements(generated);
  for (const r of removed) console.log(`migrate:dev: stripped ${r.kind.toUpperCase()} of custom index "${r.name}"`);

  if (empty) {
    console.log('migrate:dev: no schema changes — no migration written.');
    return;
  }
  if (dryRun) {
    console.log('migrate:dev: --dry-run, would write:\n');
    console.log(sql);
    return;
  }

  // Hand-written migrations use round future times (e.g. `…090000`); never sort before them.
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const latest = readdirSync(join(ROOT, 'prisma', 'migrations'))
    .map((d) => /^(\d{14})_/.exec(d)?.[1])
    .filter((d): d is string => Boolean(d))
    .sort()
    .pop();
  const stamp = latest && latest >= now ? String(BigInt(latest) + 1n) : now;
  const dir = join(ROOT, 'prisma', 'migrations', `${stamp}_${name}`);
  mkdirSync(dir, { recursive: false });
  writeFileSync(join(dir, 'migration.sql'), sql);
  console.log(`migrate:dev: wrote ${join('prisma', 'migrations', `${stamp}_${name}`, 'migration.sql')}`);
  if (createOnly) return;

  prisma(['migrate', 'deploy'], false);
  prisma(['generate'], false);
}

main();
