/**
 * Indexes that exist ONLY in hand-written migration SQL because Prisma's schema language can't
 * express them (partial `WHERE` predicates, expression keys). This list is the single source of
 * truth for:
 *
 *  - `npm run migrate:dev` (`scripts/migrate-dev-guarded.ts`) — strips any `DROP INDEX` /
 *    `CREATE INDEX` of these names from a newly generated migration before it is written, so a
 *    Prisma diff can never silently drop them;
 *  - `custom-indexes.spec.ts` — fails if a committed migration drops one of them without the
 *    explicit intent marker `-- custom-index: drop <name>`, or if an entry here is not created by
 *    the migration it names.
 *
 * Adding a new hand-written partial/expression index: create it in its own migration, then add
 * an entry here naming that migration.
 */
export interface CustomIndex {
  name: string;
  table: string;
  /** The migration folder that creates it. */
  migration: string;
  why: string;
}

export const CUSTOM_INDEXES: readonly CustomIndex[] = [
  {
    name: 'Vehicle_unitNumber_live_key',
    table: 'Vehicle',
    migration: '20260927090000_soft_delete_partial_uniques',
    why: 'unitNumber unique among live (deletedAt IS NULL) units',
  },
  {
    name: 'Vehicle_vin_live_key',
    table: 'Vehicle',
    migration: '20260927090000_soft_delete_partial_uniques',
    why: 'VIN unique among live units',
  },
  {
    name: 'Driver_username_live_key',
    table: 'Driver',
    migration: '20260927090000_soft_delete_partial_uniques',
    why: 'username unique among live drivers',
  },
  {
    name: 'Driver_email_live_key',
    table: 'Driver',
    migration: '20260927090000_soft_delete_partial_uniques',
    why: 'email unique among live drivers',
  },
  {
    name: 'Vehicle_plate_state_live_key',
    table: 'Vehicle',
    migration: '20261007090000_vehicle_plate_state_live_unique',
    why: 'licensePlate + plateState unique among live units, trim/case-insensitive (expression index)',
  },
  {
    name: 'Driver_phone_live_key',
    table: 'Driver',
    migration: '20261007100000_driver_phone_cdl_live_unique',
    why: 'phone unique among live drivers, digits-only with a leading US 1 dropped (B-100, expression index)',
  },
  {
    name: 'Driver_cdlNumber_live_key',
    table: 'Driver',
    migration: '20261007100000_driver_phone_cdl_live_unique',
    why: 'cdlNumber unique among live drivers, case/space/dash-insensitive (B-100, expression index)',
  },
  {
    name: 'Trailer_number_live_key',
    table: 'Trailer',
    migration: '20261007110000_trailer_soft_delete',
    why: 'trailer number unique among live (deletedAt IS NULL) trailers',
  },
];

export const CUSTOM_INDEX_NAMES: ReadonlySet<string> = new Set(CUSTOM_INDEXES.map((i) => i.name));

/** Marker a migration must carry to drop a custom index on purpose. */
export const dropIntentMarker = (name: string): string => `-- custom-index: drop ${name}`;

const INDEX_STATEMENT = /^\s*(DROP\s+INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+EXISTS)?|CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?)\s+(?:"?public"?\.)?"([^"]+)"/i;

/** The custom index a single SQL statement drops or creates, if any. */
export function customIndexTouchedBy(statement: string): { name: string; kind: 'drop' | 'create' } | null {
  const withoutComments = statement
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const match = INDEX_STATEMENT.exec(withoutComments);
  if (!match || !CUSTOM_INDEX_NAMES.has(match[2])) return null;
  return { name: match[2], kind: /^\s*DROP/i.test(match[1]) ? 'drop' : 'create' };
}

/** Splits SQL into statements, each keeping the comment lines directly above it. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of sql.split('\n')) {
    current.push(line);
    if (/;\s*(--.*)?$/.test(line) && !line.trim().startsWith('--')) {
      statements.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) statements.push(current.join('\n'));
  return statements;
}

const isOnlyComments = (sql: string): boolean =>
  sql.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('--'));

export interface StripResult {
  sql: string;
  removed: Array<{ name: string; kind: 'drop' | 'create'; statement: string }>;
  /** True when nothing but comments / whitespace is left — the migration should not be written. */
  empty: boolean;
}

/** Removes every DROP / CREATE INDEX of a custom index from a Prisma-generated migration. */
export function stripCustomIndexStatements(sql: string): StripResult {
  const removed: StripResult['removed'] = [];
  const kept: string[] = [];
  for (const statement of splitStatements(sql)) {
    const touched = customIndexTouchedBy(statement);
    if (touched) {
      removed.push({ ...touched, statement: statement.trim() });
      continue;
    }
    kept.push(statement);
  }
  const out = kept
    .join('\n')
    // A Prisma section header (`-- DropIndex`) left with no statement under it.
    .replace(/^-- (DropIndex|CreateIndex)\s*\n(?=\s*(\n|$|-- ))/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { sql: out === '' ? '' : `${out}\n`, removed, empty: isOnlyComments(out) };
}

/** Custom indexes a committed migration drops WITHOUT the explicit intent marker. */
export function unintendedCustomIndexDrops(sql: string): string[] {
  return splitStatements(sql)
    .map(customIndexTouchedBy)
    .filter((t): t is { name: string; kind: 'drop' } => t?.kind === 'drop')
    .map((t) => t.name)
    .filter((name) => !sql.includes(dropIntentMarker(name)));
}
