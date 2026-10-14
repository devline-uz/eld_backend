/**
 * The ONE place `src/` builds Prisma case-insensitive / LIKE-based string filters (enforced by
 * `insensitive-guard.spec.ts`).
 *
 * Why: Prisma 6 on Postgres renders these string filters as LIKE / ILIKE and passes the value
 * through UNESCAPED — verified against the dev DB (rolled-back transaction, query log):
 *
 *   `{ equals, mode: 'insensitive' }`       -> `col ILIKE $1`          (`'%'` matched every row)
 *   `{ contains | startsWith | endsWith }`  -> `col::text LIKE $1`     (`'%'`/`'_'` are wildcards)
 *     (+ `mode: 'insensitive'`)             -> `col ILIKE $1`
 *   `{ in, mode: 'insensitive' }`           -> `LOWER(col) IN (LOWER($1), …)`  (no LIKE — safe)
 *   `{ equals }` (case-sensitive)           -> `col = $1`              (safe)
 *
 * So an "exact" case-insensitive lookup is really a pattern match: `j_hn` finds `john`, `%` finds
 * anything. Every helper here escapes `\`, `%` and `_` with Postgres' default LIKE escape
 * character `\` (Prisma emits no `ESCAPE` clause, so the default applies), making the match
 * literal. Backslash is escaped first-class (it is in the same character class), so `a\b` stays
 * the literal three characters.
 *
 * The helpers do NOT trim: whether surrounding spaces are meaningful is a per-field decision, so
 * callers normalise first (e.g. `normalizeEmail`, unit number `trim()` + strip `#`).
 */

/** Escapes the LIKE metacharacters `\`, `%`, `_` with Postgres' default escape `\`. Use for raw SQL
 * too: `col ILIKE ${'%' + escapeLike(q) + '%'} ESCAPE '\'` (parameterised). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export interface InsensitiveEquals {
  equals: string;
  mode: 'insensitive';
}
export interface InsensitiveContains {
  contains: string;
  mode: 'insensitive';
}
export interface InsensitiveStartsWith {
  startsWith: string;
  mode: 'insensitive';
}
export interface InsensitiveEndsWith {
  endsWith: string;
  mode: 'insensitive';
}
export interface InsensitiveIn {
  in: string[];
  mode: 'insensitive';
}

/** Literal, case-insensitive equality (`ILIKE` with escaped value). For exact lookups: uniqueness
 * checks, login, import matching, dedupe. */
export function equalsInsensitive(value: string): InsensitiveEquals {
  return { equals: escapeLike(value), mode: 'insensitive' };
}

/** Literal, case-insensitive substring match — search boxes (`%` / `_` typed by a user are literal). */
export function containsInsensitive(value: string): InsensitiveContains {
  return { contains: escapeLike(value), mode: 'insensitive' };
}

/** Literal, case-insensitive prefix match. */
export function startsWithInsensitive(value: string): InsensitiveStartsWith {
  return { startsWith: escapeLike(value), mode: 'insensitive' };
}

/** Literal, case-insensitive suffix match. */
export function endsWithInsensitive(value: string): InsensitiveEndsWith {
  return { endsWith: escapeLike(value), mode: 'insensitive' };
}

/** Case-insensitive set membership. Prisma renders this as `LOWER(col) IN (LOWER($1), …)` — NOT a
 * LIKE — so the values must NOT be escaped (escaping would add literal backslashes). */
export function inInsensitive(values: string[]): InsensitiveIn {
  return { in: values, mode: 'insensitive' };
}
