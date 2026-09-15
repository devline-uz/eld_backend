/**
 * Seed helper for the "last-known position" step (`prisma/seed.ts`, D-053) — kept in `src/` so
 * the unit project can test it.
 *
 * B-044: the seed's ANCHOR is today 15:41 home-terminal time, which is in the FUTURE whenever
 * the seed runs earlier in the day. `GET /live/fleet` ignores fixes dated after now (+10 min
 * device-clock tolerance), so a fix stamped off ANCHOR would stay invisible for hours. The fix
 * time is therefore taken from the EARLIER of ANCHOR and real now, minus the per-unit offset.
 */
export function seedFixTime(anchor: Date, now: Date, offsetMinutes: number): Date {
  const base = Math.min(anchor.getTime(), now.getTime());
  return new Date(base - Math.max(0, offsetMinutes) * 60_000);
}
