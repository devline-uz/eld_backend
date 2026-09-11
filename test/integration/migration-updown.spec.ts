/**
 * tasks.md Global gate — "Every migration tested `up` and `down` on the **dev DB**".
 *
 * Two levels:
 *   1) a cheap structural check (every migration directory ships a down.sql), which fails
 *      fast the moment someone adds a migration without a reverse path;
 *   2) the real thing: `scripts/migrate-updown-dev.sh`, which applies and reverts every
 *      migration on the dev Postgres server (inside a scratch database it creates and
 *      drops itself) and diffs the schema + effective append-only privileges after each
 *      step. Roughly 70s for the current 5 migrations, hence the generous timeout.
 *
 * The script refuses to run against onebook_eld (prod) or any database other than
 * onebook_eld_dev — see its own guard block.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BACKEND_DIR = resolve(__dirname, '../..');
const MIGRATIONS_DIR = join(BACKEND_DIR, 'prisma/migrations');

const migrationDirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe('Prisma migrations — up/down on the dev DB', () => {
  it('has at least the initial migration', () => {
    expect(migrationDirs.length).toBeGreaterThan(0);
  });

  it.each(migrationDirs)('%s ships a down.sql', (name) => {
    expect(existsSync(join(MIGRATIONS_DIR, name, 'migration.sql'))).toBe(true);
    expect(existsSync(join(MIGRATIONS_DIR, name, 'down.sql'))).toBe(true);
  });

  it(
    'applies and reverts every migration on the dev server (scripts/migrate-updown-dev.sh)',
    () => {
      let output: string;
      try {
        output = execFileSync('bash', ['scripts/migrate-updown-dev.sh'], {
          cwd: BACKEND_DIR,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        throw new Error(
          `migrate-updown-dev.sh failed:\n--- stdout ---\n${e.stdout ?? ''}\n--- stderr ---\n${e.stderr ?? ''}`,
        );
      }
      for (const name of migrationDirs) {
        expect(output).toContain(`[${name}] OK (up · down · up)`);
      }
      expect(output).toContain('passed up · down · up');
    },
    10 * 60 * 1000,
  );
});
