/**
 * BUG-001 — 49 CFR §395.1(b)(1): adverse driving conditions are a per-day exception that must be
 * invoked and annotated. `Driver.adverseDrivingEnabled` only PERMITS it; the engine's +2 h drive /
 * shift extension may apply only on a RODS day with an `AdverseDrivingInvocation` row.
 *
 * Web-panel reads (`GET /drivers/roster`, `GET /drivers/:id/hos`, `GET /live/fleet`) hand the
 * engine a driver row whose flag is the EFFECTIVE one: permitted AND invoked for today.
 */
import type { PrismaService } from '../../../core/prisma/prisma.service';
import { dayKey } from '../../hos/engine/timezone';

interface AdverseDriverRow {
  id: string;
  homeTerminalTimezone: string;
  adverseDrivingEnabled: boolean;
}

/** "YYYY-MM-DD" → the UTC midnight Prisma uses for a `@db.Date` column. */
function utcDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** Ids of the PERMITTED drivers that have adverse driving invoked for their current RODS day. */
export async function findAdverseInvokedToday(
  prisma: PrismaService,
  drivers: AdverseDriverRow[],
  now: Date,
): Promise<Set<string>> {
  const permitted = drivers.filter((d) => d.adverseDrivingEnabled);
  if (permitted.length === 0) return new Set();
  const today = new Map(permitted.map((d) => [d.id, dayKey(d.homeTerminalTimezone, now)]));
  const rows = await prisma.adverseDrivingInvocation.findMany({
    where: { driverId: { in: [...today.keys()] }, logDate: { in: [...new Set(today.values())].map(utcDate) } },
    select: { driverId: true, logDate: true },
  });
  return new Set(rows.filter((r) => dayKey('UTC', r.logDate) === today.get(r.driverId)).map((r) => r.driverId));
}

/** Copies of `drivers` whose `adverseDrivingEnabled` is true only when invoked for today. */
export function withEffectiveAdverse<T extends AdverseDriverRow>(drivers: T[], invoked: Set<string>): T[] {
  return drivers.map((d) => (d.adverseDrivingEnabled && !invoked.has(d.id) ? { ...d, adverseDrivingEnabled: false } : d));
}
