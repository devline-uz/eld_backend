/**
 * In-memory evaluation of Prisma string filters the way Postgres executes them for Prisma 6
 * (verified against the dev DB with the query log, see `src/common/text/insensitive.ts`):
 *
 *   `{ equals, mode: 'insensitive' }`             -> `col ILIKE $1`     (value NOT escaped by Prisma)
 *   `{ contains | startsWith | endsWith }`        -> `col LIKE '%'||$1||'%'` etc. (NOT escaped)
 *     with `mode: 'insensitive'`                  -> ILIKE
 *   `{ in, mode: 'insensitive' }`                 -> `LOWER(col) IN (LOWER($1), …)`
 *   `{ equals }` / plain scalar                   -> `=`
 *
 * LIKE patterns honour Postgres' default `\` escape. Lets unit tests prove that a repository's
 * filter really is literal (a `%` / `_` look-alike does not match) without touching a database.
 */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function likeToRegExp(pattern: string, insensitive: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) re += pattern[++i].replace(REGEX_SPECIAL, '\\$&');
    else if (ch === '%') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(REGEX_SPECIAL, '\\$&');
  }
  return new RegExp(`^${re}$`, insensitive ? 'is' : 's');
}

/** `value ILIKE pattern` (default `\` escape). */
export function ilike(value: string, pattern: string): boolean {
  return likeToRegExp(pattern, true).test(value);
}

/** `value LIKE pattern` (default `\` escape). */
export function like(value: string, pattern: string): boolean {
  return likeToRegExp(pattern, false).test(value);
}

export interface StringFilter {
  equals?: string | null;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  in?: string[];
  not?: unknown;
  mode?: 'insensitive' | 'default';
}

/** One Prisma string filter (or a plain scalar / null) against a stored value. */
export function matchesStringFilter(stored: string | null | undefined, filter: unknown): boolean {
  if (filter === null) return stored === null || stored === undefined;
  if (typeof filter !== 'object') return stored === filter;
  const f = filter as StringFilter;
  const ci = f.mode === 'insensitive';
  const test = ci ? ilike : like;
  if (stored === null || stored === undefined) return f.equals === null;
  if (f.equals !== undefined && f.equals !== null && !(ci ? ilike(stored, f.equals) : stored === f.equals)) return false;
  if (f.contains !== undefined && !test(stored, `%${f.contains}%`)) return false;
  if (f.startsWith !== undefined && !test(stored, `${f.startsWith}%`)) return false;
  if (f.endsWith !== undefined && !test(stored, `%${f.endsWith}`)) return false;
  if (f.in !== undefined && !f.in.some((v) => (ci ? v.toLowerCase() === stored.toLowerCase() : v === stored))) return false;
  if (f.not !== undefined && matchesStringFilter(stored, f.not)) return false;
  return true;
}

/** A flat Prisma `where` (scalar fields, string filters, `AND` / `OR`) against one row. */
export function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, filter]) => {
    if (filter === undefined) return true;
    if (key === 'OR') return (filter as Record<string, unknown>[]).some((w) => matchesWhere(row, w));
    if (key === 'AND') return (filter as Record<string, unknown>[]).every((w) => matchesWhere(row, w));
    const stored = row[key];
    if (stored instanceof Date || typeof stored === 'boolean' || typeof stored === 'number') return stored === filter;
    return matchesStringFilter(stored as string | null | undefined, filter);
  });
}

/** A Prisma model delegate stand-in over `rows` that evaluates `where` like Postgres would. */
export function fakeLikeTable<T extends Record<string, unknown>>(rows: T[]) {
  const findFirst = jest.fn(async (args: { where?: Record<string, unknown> } = {}) => rows.find((r) => matchesWhere(r, args.where)) ?? null);
  const findMany = jest.fn(async (args: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matchesWhere(r, args.where)));
  const findUnique = jest.fn(async (args: { where: Record<string, unknown> }) =>
    rows.find((r) => Object.entries(args.where).every(([k, v]) => r[k] === v)) ?? null,
  );
  const count = jest.fn(async (args: { where?: Record<string, unknown> } = {}) => rows.filter((r) => matchesWhere(r, args.where)).length);
  return { findFirst, findMany, findUnique, count };
}
