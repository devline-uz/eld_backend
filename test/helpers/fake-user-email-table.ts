/**
 * In-memory stand-in for `prisma.user.findFirst` that evaluates an email filter the way Postgres
 * does for Prisma's `{ equals, mode: 'insensitive' }` — `email ILIKE $1` with the default `\` escape
 * (verified: Prisma does not escape `%` / `_` itself). Lets unit tests prove that a lookup really
 * matches lower-case and legacy mixed-case rows, and never lets a wildcard resolve another account.
 */
import { ilike } from './fake-like-filters';

export { ilike };

type EmailFilter = string | { equals: string; mode?: 'insensitive' };

function matches(stored: string, filter: EmailFilter): boolean {
  if (typeof filter === 'string') return stored === filter;
  return filter.mode === 'insensitive' ? ilike(stored, filter.equals) : stored === filter.equals;
}

export function fakeUserEmailTable<T extends { email: string }>(rows: T[]) {
  const findFirst = jest.fn(async ({ where }: { where: { email: EmailFilter } }) => rows.find((r) => matches(r.email, where.email)) ?? null);
  const findUnique = jest.fn(async ({ where }: { where: { email?: string; id?: string } }) =>
    rows.find((r) => (where.email !== undefined ? r.email === where.email : (r as unknown as { id: string }).id === where.id)) ?? null,
  );
  return { prisma: { user: { findFirst, findUnique } }, findFirst, findUnique };
}
