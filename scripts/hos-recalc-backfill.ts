/**
 * LIVE-001 / CODE-006 / CODE-007 — one-off HOS re-evaluation of existing data.
 *
 *   npx ts-node scripts/hos-recalc-backfill.ts                       # DRY RUN (default): print the plan
 *   npx ts-node scripts/hos-recalc-backfill.ts --apply               # queue the jobs
 *   ... --driver <id> [--driver <id>]                                # only these drivers
 *   ... --all-drivers --from 2026-09-01                              # every driver from that RODS day (CODE-006)
 *   ... --unidentified-report                                        # list CODE-007 assignments to reject + re-assign
 *
 * What it does: reads (never writes) `HosViolation` / `Driver` / `UnidentifiedSegment` /
 * `EldEvent`, and with `--apply` adds `hos.recalc` jobs `{ driverId, fromDate, silent: true }` (silent = no alerts) to the
 * `hos-recalc` queue. The WORKER runs them through `HosRecalcService.recalculate` — the same
 * idempotent code path as every log change: violations are upserted on (driverId, logDate, type),
 * OPEN rows the records no longer support become AUTO_CLEARED with a `HOS_VIOLATION_AUTO_CLEARED`
 * AuditLog entry (never deleted), RESOLVED rows are never reopened, day totals are rebuilt and
 * certification is never touched. Nothing runs in this script or the API.
 *
 * `fromDate` per driver = their earliest OPEN violation day (or `--from`, if older), so every
 * orphan OPEN row (LIVE-001: seeded rows without records, rows left by a since-corrected log) is
 * inside the recalculated range.
 *
 * Reads DATABASE_URL / REDIS_URL / REDIS_DB / QUEUE_PREFIX from the environment (`.env`, as the
 * app). Prints only the database host/name, never credentials.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { isUnclosedAssignment, parseBackfillArgs, planBackfillJobs } from '../src/modules/hos-recalc/hos-backfill';

const QUEUE = 'hos-recalc';

function describeDb(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function unidentifiedReport(prisma: PrismaClient): Promise<void> {
  const segments = await prisma.unidentifiedSegment.findMany({
    where: { status: 'ASSIGNED', assignedDriverId: { not: null } },
    orderBy: { startAt: 'asc' },
    select: { id: true, vehicleId: true, startAt: true, endAt: true, assignedDriverId: true, assignedAt: true },
  });
  let suspects = 0;
  for (const segment of segments) {
    const atEnd = await prisma.eldEvent.findMany({
      where: { driverId: segment.assignedDriverId, eventDateTime: segment.endAt },
      select: { id: true, eventType: true, recordStatus: true, supersedesId: true },
    });
    if (!isUnclosedAssignment(atEnd)) continue;
    suspects += 1;
    console.log(
      `  segment ${segment.id}  driver ${segment.assignedDriverId}  vehicle ${segment.vehicleId}  ` +
        `${segment.startAt.toISOString()} -> ${segment.endAt.toISOString()}  assignedAt ${segment.assignedAt?.toISOString() ?? '-'}`,
    );
  }
  console.log(`CODE-007: ${suspects} of ${segments.length} ASSIGNED segment(s) were never closed on the driver's log.`);
  if (suspects) {
    console.log('  Fix each one in the panel/API: POST /unidentified/:id/reject, then POST /unidentified/:id/assign again');
    console.log('  (the new assignment writes the closing RESTORE record or refuses an overlap). Then run this script with --apply.');
  }
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  console.log(`hos-recalc-backfill — database ${describeDb(process.env.DATABASE_URL)} — ${args.apply ? 'APPLY (queue jobs)' : 'DRY RUN'}`);

  const prisma = new PrismaClient();
  try {
    if (args.unidentifiedReport) await unidentifiedReport(prisma);

    const grouped = await prisma.hosViolation.groupBy({
      by: ['driverId'],
      where: { status: 'OPEN', ...(args.driverIds.length ? { driverId: { in: args.driverIds } } : {}) },
      _min: { logDate: true },
      _count: { _all: true },
    });
    const open = grouped
      .filter((row) => row._min.logDate)
      .map((row) => ({ driverId: row.driverId, earliestOpen: row._min.logDate!.toISOString().slice(0, 10), openCount: row._count._all }));
    const allDriverIds = args.allDrivers
      ? (await prisma.driver.findMany({ where: { deletedAt: null }, select: { id: true } })).map((d) => d.id)
      : [];
    // The service clamps every day to the driver's own "today"; UTC tomorrow is a safe upper bound.
    const today = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const jobs = planBackfillJobs(open, { from: args.from, allDriverIds, driverIds: args.driverIds, today });

    for (const job of jobs) console.log(`  driver ${job.driverId}  fromDate ${job.fromDate}  open violations ${job.openCount}`);
    console.log(`${jobs.length} hos.recalc job(s) planned.`);
    if (!args.apply || jobs.length === 0) {
      if (!args.apply) console.log('Dry run — nothing queued. Re-run with --apply to queue them.');
      return;
    }

    const queue = new Queue(QUEUE, {
      connection: { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', db: Number(process.env.REDIS_DB ?? 0) },
      prefix: process.env.QUEUE_PREFIX,
    });
    try {
      for (const job of jobs) {
        await queue.add('hos.recalc', { driverId: job.driverId, fromDate: job.fromDate, silent: true }, { removeOnComplete: { count: 1000 }, removeOnFail: { count: 1000 } });
      }
      console.log(`Queued ${jobs.length} hos.recalc job(s); the worker processes them one at a time.`);
    } finally {
      await queue.close();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
