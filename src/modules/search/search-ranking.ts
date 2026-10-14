/**
 * LIVE-009 — how the command palette matches and orders hits. Pure on purpose: the repository
 * fetches a bounded candidate set, these decide the order the user sees.
 */

/** At most this many words of `q` are matched (each one is an AND-ed `OR` over the name columns). */
export const SEARCH_MAX_TOKENS = 5;

/** Candidates fetched per section before ranking, so an exact match is never cut off by `take`. */
export function candidateLimit(limit: number): number {
  return Math.min(50, Math.max(limit, limit * 5));
}

/** `"  Richard   Lewis "` → `["Richard", "Lewis"]`. */
export function searchTokens(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean).slice(0, SEARCH_MAX_TOKENS);
}

/** `"#106"` / `" 106 "` → `"106"` — the unit number as the vehicle form normalises it. */
export function normalizeUnitQuery(q: string): string {
  return q.trim().replace(/^#+/, '').trim();
}

const lower = (value: string | null | undefined) => (value ?? '').toLowerCase();
const byText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

interface RankableDriver {
  firstName: string;
  lastName: string;
  username: string;
}

/** 0 exact full name / username · 1 full name starts with `q` · 2 a name word starts with each token · 3 other. */
function driverScore(row: RankableDriver, q: string, tokens: string[]): number {
  const query = lower(q.trim()).replace(/\s+/g, ' ');
  const full = lower(`${row.firstName} ${row.lastName}`.trim());
  if (full === query || lower(row.username) === query) return 0;
  if (full.startsWith(query)) return 1;
  const words = [...full.split(/\s+/), lower(row.username)];
  if (tokens.every((token) => words.some((word) => word.startsWith(lower(token))))) return 2;
  return 3;
}

export function rankDrivers<T extends RankableDriver>(rows: T[], q: string, limit: number): T[] {
  const tokens = searchTokens(q);
  return rows
    .map((row) => ({ row, score: driverScore(row, q, tokens), name: `${row.firstName} ${row.lastName}` }))
    .sort((a, b) => a.score - b.score || byText(a.name, b.name))
    .slice(0, limit)
    .map(({ row }) => row);
}

interface RankableVehicle {
  unitNumber: string;
  vin: string;
}

/** 0 exact unit number (ignoring `#`) or VIN · 1 unit starts with `q` · 2 other. */
function vehicleScore(row: RankableVehicle, q: string): number {
  const unitQuery = lower(normalizeUnitQuery(q));
  const unit = lower(normalizeUnitQuery(row.unitNumber));
  if (unit === unitQuery || lower(row.vin) === lower(q.trim())) return 0;
  if (unit.startsWith(unitQuery)) return 1;
  return 2;
}

export function rankVehicles<T extends RankableVehicle>(rows: T[], q: string, limit: number): T[] {
  return rows
    .map((row) => ({ row, score: vehicleScore(row, q) }))
    .sort((a, b) => a.score - b.score || byText(a.row.unitNumber, b.row.unitNumber))
    .slice(0, limit)
    .map(({ row }) => row);
}
