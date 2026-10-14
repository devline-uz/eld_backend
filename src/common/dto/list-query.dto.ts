import { z } from 'zod';

/**
 * TZ rule (Phase 2 brief) — "Lists use `?page&limit&sort&q` with cursor pagination on large
 * tables." Vehicles/Drivers/Devices are fleet-sized (hundreds, not the millions of `EldEvent`
 * or `AuditLog`), so these lists use offset paging — matching the numbered page controls in
 * the Figma fleet screens (`Vehicles`, `Drivers`, `Settings > ELD devices`) — while
 * `AuditRepository`/future `EldEvent` reads keep `BaseRepository.paginate`'s cursor form.
 */
/**
 * BE-007 — upper bound for every web list's `page`. Unbounded, `?page=99999999999` became an
 * `OFFSET` past Postgres' bigint / Prisma's int range and surfaced as a 500; 10,000 pages × the
 * 200-row max limit is far beyond any fleet table.
 */
export const MAX_LIST_PAGE = 10_000;

export const ListQueryDto = z.object({
  page: z.coerce.number().int().min(1).max(MAX_LIST_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  /** `"field:asc"` or `"field:desc"`; unknown fields fall back to the caller's default. */
  sort: z.string().max(60).optional(),
  /** Free-text search, matched against each module's own set of `contains` fields. */
  q: z.string().max(200).optional(),
});
export type ListQueryDto = z.infer<typeof ListQueryDto>;

export type SortDirection = 'asc' | 'desc';

/** Parses `sort` into a Prisma `orderBy` object, rejecting fields outside `allowed`. */
export function parseSort<TField extends string>(
  sort: string | undefined,
  allowed: readonly TField[],
  fallback: Record<string, SortDirection>,
): Record<string, SortDirection> {
  if (!sort) return fallback;
  const [field, dir] = sort.split(':');
  if (!allowed.includes(field as TField)) return fallback;
  return { [field]: dir === 'desc' ? 'desc' : 'asc' };
}

export interface OffsetPage<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function toOffsetPage<T>(items: T[], total: number, page: number, limit: number): OffsetPage<T> {
  return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/**
 * BE-014 — Prisma's `contains` / `startsWith` put the value into `LIKE '%…%'` WITHOUT escaping
 * (verified against Postgres: `q=%` matched every row, `q=_` any one char, a lone `\` nothing).
 * Re-exported from `common/text/insensitive.ts`, which owns it together with the filter helpers.
 */
export { escapeLike } from '../text/insensitive';
