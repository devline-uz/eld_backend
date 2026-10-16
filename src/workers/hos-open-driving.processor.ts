import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import { staleStatusCapAt } from '../modules/drivers/lib/stale-status';
import { addDays, dayKey } from '../modules/hos/engine/timezone';
import { HosRecalcRepository, type OpenDrivingRow } from '../modules/hos-recalc/hos-recalc.repository';

/** Every 5 minutes: the same cadence the mobile app posts its HOS state at (§8.6 point 5). */
export const HOS_OPEN_DRIVING_CRON = '*/5 * * * *';
export const HOS_OPEN_DRIVING_JOB_NAME = 'hos.open-driving.sweep';
/** Fixed repeat key: re-registering on every worker boot updates the schedule, never duplicates it. */
export const HOS_OPEN_DRIVING_REPEAT_JOB_ID = 'hos-open-driving-sweep';
/** How far back an open DRIVING record is looked for, and the earliest day a sweep recalculates. */
export const HOS_OPEN_DRIVING_LOOKBACK_DAYS = 14;

export interface OpenDrivingSweepResult {
  scanned: number;
  enqueued: number;
}

/**
 * The first RODS day `hos.recalc` must rewrite for a driver still driving: the day the open record
 * began (every violation of that run is filed on it or later), never more than the lookback back.
 */
export function openDrivingFromDate(row: OpenDrivingRow, now: Date): string {
  const earliest = addDays(dayKey(row.homeTerminalTimezone, now), -HOS_OPEN_DRIVING_LOOKBACK_DAYS);
  const start = dayKey(row.homeTerminalTimezone, row.since);
  return start < earliest ? earliest : start;
}

/** BE-03 — one at-cap recalculation per stuck DRIVING record (BullMQ job id; no ':' in v5). */
export function staleRecalcJobId(row: OpenDrivingRow): string {
  return `hos-recalc-stale-${row.driverId}-${row.since.getTime()}`;
}

/**
 * `hos.recalc` runs when records arrive (ingest, edits, unidentified assignment). A driver whose
 * last record is DRIVING keeps accruing driving, window and cycle time with no new record — the
 * ELD simply has not reported a stop — so their 11 h / 14 h / 30 min / 70 h violations never
 * reached `HosViolation`: the HOS log said "No violations today" over 24:00 of driving, and the
 * dashboard, roster and log disagreed. This sweep re-queues `hos.recalc` for exactly those drivers.
 *
 * Worker container only (§3.3). It writes nothing itself; the recalculation it enqueues is the
 * existing idempotent upsert on (driverId, logDate, type), serialised by the recalc queue.
 */
@Processor(QUEUES.HOS_OPEN_DRIVING, { concurrency: 1 })
export class HosOpenDrivingProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(HosOpenDrivingProcessor.name);

  constructor(
    private readonly repo: HosRecalcRepository,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.HOS_OPEN_DRIVING) private readonly queue: Queue,
    @InjectQueue(QUEUES.HOS_RECALC) private readonly recalcQueue: Queue,
  ) {
    super();
  }

  /** Self-scheduling: the repeatable job is (re)declared by the worker that will run it. */
  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      await this.queue.add(
        HOS_OPEN_DRIVING_JOB_NAME,
        {},
        {
          repeat: { pattern: HOS_OPEN_DRIVING_CRON, tz: 'UTC' },
          jobId: HOS_OPEN_DRIVING_REPEAT_JOB_ID,
          removeOnComplete: { count: 30 },
        },
      );
      this.logger.log({ cron: HOS_OPEN_DRIVING_CRON }, 'Open-driving HOS sweep scheduled');
    } catch (err) {
      // A worker that cannot reach Redis at boot must still start; BullMQ retries the connection.
      this.logger.error({ err }, 'Failed to schedule the open-driving HOS sweep');
    }
  }

  async process(job: Job): Promise<OpenDrivingSweepResult> {
    const result = await this.sweep(new Date());
    this.logger.log({ jobId: job.id, ...result }, 'hos.open-driving sweep processed');
    return result;
  }

  async sweep(now: Date): Promise<OpenDrivingSweepResult> {
    const since = new Date(now.getTime() - HOS_OPEN_DRIVING_LOOKBACK_DAYS * 86_400_000);
    const rows = await this.repo.findOpenDrivingDrivers(since, now);
    let enqueued = 0;
    for (const row of rows) {
      try {
        const fromDate = openDrivingFromDate(row, now);
        // BE-03 / BUG-002 — past the 16 h stale-status cap the ELD went silent; the driver is not
        // still driving. Recalculate AS OF the cap (what was crossed before it stays filed) and only
        // once per stuck record, so nothing after the cap is filed or alerted.
        const capAt = staleStatusCapAt('D', row.since, now);
        if (capAt) {
          await this.recalcQueue.add('hos.recalc', { driverId: row.driverId, fromDate, asOf: capAt.toISOString() }, { jobId: staleRecalcJobId(row) });
        } else {
          await this.recalcQueue.add('hos.recalc', { driverId: row.driverId, fromDate });
        }
        enqueued += 1;
      } catch (err) {
        this.logger.error({ err, driverId: row.driverId }, 'Failed to enqueue hos.recalc for an open driving record');
      }
    }
    return { scanned: rows.length, enqueued };
  }
}
