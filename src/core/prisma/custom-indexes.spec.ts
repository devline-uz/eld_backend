import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CUSTOM_INDEXES,
  customIndexTouchedBy,
  dropIntentMarker,
  stripCustomIndexStatements,
  unintendedCustomIndexDrops,
} from './custom-indexes';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations');
const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(MIGRATIONS_DIR, d.name, 'migration.sql')))
  .map((d) => ({ name: d.name, sql: readFileSync(join(MIGRATIONS_DIR, d.name, 'migration.sql'), 'utf8') }));

describe('custom (hand-written) indexes guard', () => {
  describe('committed migrations', () => {
    it.each(migrations.map((m) => [m.name, m.sql]))('%s never drops a custom index without the intent marker', (_name, sql) => {
      expect(unintendedCustomIndexDrops(sql)).toEqual([]);
    });

    it.each(CUSTOM_INDEXES.map((i) => [i.name, i.migration]))('%s is created by %s', (name, migration) => {
      const found = migrations.find((m) => m.name === migration);
      expect(found).toBeDefined();
      const creates = stripCustomIndexStatements(found!.sql).removed.filter((r) => r.kind === 'create').map((r) => r.name);
      expect(creates).toContain(name);
    });
  });

  describe('customIndexTouchedBy', () => {
    it.each([
      ['DROP INDEX "Vehicle_vin_live_key";', { name: 'Vehicle_vin_live_key', kind: 'drop' }],
      ['DROP INDEX IF EXISTS "public"."Driver_email_live_key";', { name: 'Driver_email_live_key', kind: 'drop' }],
      ['-- DropIndex\nDROP INDEX "Vehicle_plate_state_live_key";', { name: 'Vehicle_plate_state_live_key', kind: 'drop' }],
      ['CREATE UNIQUE INDEX "Vehicle_unitNumber_live_key" ON "Vehicle"("unitNumber");', { name: 'Vehicle_unitNumber_live_key', kind: 'create' }],
    ])('recognises %j', (statement, expected) => {
      expect(customIndexTouchedBy(statement)).toEqual(expected);
    });

    it('ignores ordinary Prisma indexes', () => {
      expect(customIndexTouchedBy('DROP INDEX "Vehicle_vin_idx";')).toBeNull();
      expect(customIndexTouchedBy('CREATE INDEX "Vehicle_status_idx" ON "Vehicle"("status");')).toBeNull();
    });
  });

  describe('stripCustomIndexStatements', () => {
    it('removes custom-index drops/creates and keeps everything else', () => {
      const sql = [
        '-- DropIndex',
        'DROP INDEX "Vehicle_plate_state_live_key";',
        '',
        '-- DropIndex',
        'DROP INDEX "Vehicle_vin_live_key";',
        '',
        '-- AlterTable',
        'ALTER TABLE "Vehicle" ADD COLUMN "color" TEXT;',
        '',
        '-- CreateIndex',
        'CREATE UNIQUE INDEX "Vehicle_unitNumber_live_key"',
        '  ON "Vehicle"("unitNumber");',
        '',
      ].join('\n');
      const result = stripCustomIndexStatements(sql);
      expect(result.removed.map((r) => r.name)).toEqual([
        'Vehicle_plate_state_live_key',
        'Vehicle_vin_live_key',
        'Vehicle_unitNumber_live_key',
      ]);
      expect(result.sql).toBe('-- AlterTable\nALTER TABLE "Vehicle" ADD COLUMN "color" TEXT;\n');
      expect(result.empty).toBe(false);
    });

    it('reports a migration that only touched custom indexes as empty', () => {
      const result = stripCustomIndexStatements('-- DropIndex\nDROP INDEX "Driver_username_live_key";\n');
      expect(result.empty).toBe(true);
      expect(result.sql).toBe('');
    });
  });

  describe('unintendedCustomIndexDrops', () => {
    it('flags a bare drop and accepts one with the intent marker', () => {
      const drop = 'DROP INDEX "Vehicle_vin_live_key";\n';
      expect(unintendedCustomIndexDrops(drop)).toEqual(['Vehicle_vin_live_key']);
      expect(unintendedCustomIndexDrops(`${dropIntentMarker('Vehicle_vin_live_key')}\n${drop}`)).toEqual([]);
    });
  });
});
