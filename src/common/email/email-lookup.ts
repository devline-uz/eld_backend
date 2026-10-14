import { equalsInsensitive, type InsensitiveEquals } from '../text/insensitive';

/** Canonical stored form of a login email: trimmed + lower-cased. `User.email` is unique on
 * `lower(email)` (migration `20261014120000_user_email_lowercase`), so every write and every lookup
 * goes through this. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Prisma `where` filter for "this column equals `email`, ignoring case and surrounding spaces".
 *
 * Prisma (v6, Postgres) renders `{ equals, mode: 'insensitive' }` as `col ILIKE $1` WITHOUT escaping
 * the value — verified against the dev DB: `equals: '%'` matched any user and `j_hn@x.com` matched
 * `john@x.com`. For a login / Google sign-in lookup that would let one address resolve to another
 * account, so the LIKE metacharacters are escaped (`equalsInsensitive`, Postgres' default `\` escape)
 * and the filter is a literal case-insensitive equality. Legacy mixed-case rows still match.
 */
export function emailEqualsInsensitive(email: string): InsensitiveEquals {
  return equalsInsensitive(normalizeEmail(email));
}
