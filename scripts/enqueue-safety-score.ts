/**
 * D-133 — one-off W-10 scorecard run: `npx ts-node scripts/enqueue-safety-score.ts [YYYY-MM-DD]`.
 *
 * Adds a single `safety.score` job to the `safety-score` queue; the running WORKER computes it
 * (same code path as the nightly run, nothing runs in this script or the API). The optional date
 * is the last day of the 30-day period; omitted = the newest day complete in every driver's zone.
 * Reads REDIS_URL / REDIS_DB / QUEUE_PREFIX from .env (same as the app). No HTTP endpoint is
 * exposed for this on purpose — recomputation is an operator action, not a panel button.
 */
import 'dotenv/config';
import { Queue } from 'bullmq';

async function main(): Promise<void> {
  const endDate = process.argv[2];
  if (endDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error(`Expected YYYY-MM-DD, got "${endDate}"`);
  }
  const queue = new Queue('safety-score', {
    connection: { url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', db: Number(process.env.REDIS_DB ?? 0) },
    prefix: process.env.QUEUE_PREFIX,
  });
  try {
    const job = await queue.add('safety.score', endDate ? { endDate } : {}, { removeOnComplete: { count: 30 }, removeOnFail: { count: 100 } });
    console.log(`enqueued safety.score job ${job.id}${endDate ? ` (period ending ${endDate})` : ''}`);
  } finally {
    await queue.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
