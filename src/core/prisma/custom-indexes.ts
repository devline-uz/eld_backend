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
  {
    name: 'User_email_lower_key',
    table: 'User',
    migration: '20261014120000_user_email_lowercase',
    why: 'web-user email unique ignoring case (expression index on lower(email))',
  },
  {
    name: 'Device_serial_upper_key',
    table: 'Device',
    migration: '20261014150000_device_serial_upper_unique',
    why: 'ELD device serial unique ignoring case and surrounding spaces (CODE-009, expression index)',
  },
  {
    name: 'Vehicle_unitNumber_canonical_live_key',
    table: 'Vehicle',
    migration: '20261014200000_vehicle_unit_plate_canonical',
    why: 'live unit number unique ignoring case, surrounding spaces and a leading # (CODE-044, expression index)',
  },
  {
    name: 'Role_name_lower_key',
    table: 'Role',
    migration: '20261014210000_user_lockout_role_name_unique',
    why: 'role display name unique ignoring case and surrounding spaces (CODE-087, expression index)',
  },
  {
    name: 'TelemetryPoint_vehicleId_time_fix_idx',
    table: 'TelemetryPoint',
    migration: '20261015090000_live_fleet_latest_row_indexes',
    why: 'latest telemetry point WITH a GPS fix per vehicle for GET /live/fleet (LV-01, partial index)',
  },
  {
    name: 'EldEvent_driverId_eventDateTime_duty_idx',
    table: 'EldEvent',
    migration: '20261015090000_live_fleet_latest_row_indexes',
    why: 'duty-status / PC-YM records (eventType 1, 3) per driver for the batched HOS clocks (LV-01, partial index)',
  },
  {
    name: 'Driver_username_lower_live_key',
    table: 'Driver',
    migration: '20261016090000_driver_username_trailer_number_ci_unique',
    why: 'live driver username unique ignoring case and surrounding spaces (B3-06, expression index)',
  },
  {
    name: 'Trailer_number_upper_live_key',
    table: 'Trailer',
    migration: '20261016090000_driver_username_trailer_number_ci_unique',
    why: 'live trailer number unique ignoring case and surrounding spaces (B3-06, expression index)',
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
