import { Prisma } from '@prisma/client';

/**
 * A JS `Date` as a UTC `timestamp` (without time zone) SQL expression, for raw queries.
 *
 * Every app `DateTime` column is `timestamp(3)` holding UTC wall-clock time, but Prisma binds a
 * `Date` parameter of `$queryRaw` / `Prisma.sql` as `timestamptz`. Comparing `"col" <= ${date}`
 * then makes Postgres cast the COLUMN to `timestamptz` using the session `TimeZone`, so the window
 * shifts by the session offset (+5 h on an `Asia/Tashkent` session) and the column index is no
 * longer used for the comparison. `${date}::timestamptz AT TIME ZONE 'UTC'` turns the parameter
 * into the matching UTC `timestamp` instead — session-TimeZone independent, and it keeps the column
 * side bare (`"col" <= ${utcTimestamp(date)}`), so btree indexes and partition pruning still apply.
 */
export function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;
}
