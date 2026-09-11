import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfigService } from '../core/config/config.service';
import { MaintenanceSchedulesService } from '../modules/service/maintenance-schedules.service';
import { QUEUES } from '../core/queue/queue.constants';

/** TZ §5.10 — nightly due/overdue sweep over `MaintenanceSchedule`, worker container only
 * (§3.3), same self-scheduling shape as `HosDriftProcessor`. */
export const MAINTENANCE_DUE_CRON = '15 4 * * *';
export const MAINTENANCE_DUE_JOB_NAME = 'maintenance.due.nightly';
export const MAINTENANCE_DUE_REPEAT_JOB_ID = 'maintenance-due-nightly';

export interface MaintenanceDueSweepResult {
  scanned: number;
  dueSoon: number;
  overdue: number;
}

@Processor(QUEUES.MAINTENANCE_DUE, { concurrency: 1 })
export class MaintenanceDueProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceDueProcessor.name);

  constructor(
    private readonly schedules: MaintenanceSchedulesService,
    private readonly config: AppConfigService,
    @InjectQueue(QUEUES.MAINTENANCE_DUE) private readonly queue: Queue,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      await this.queue.add(
        MAINTENANCE_DUE_JOB_NAME,
        {},
        { repeat: { pattern: MAINTENANCE_DUE_CRON, tz: 'UTC' }, jobId: MAINTENANCE_DUE_REPEAT_JOB_ID, removeOnComplete: { count: 30 } },
      );
      this.logger.log({ cron: MAINTENANCE_DUE_CRON }, 'Nightly maintenance-due sweep scheduled');
    } catch (err) {
      this.logger.error({ err }, 'Failed to schedule the nightly maintenance-due sweep');
    }
  }

  async process(job: Job): Promise<MaintenanceDueSweepResult> {
    const due = await this.schedules.sweepDue();
    let dueSoon = 0;
    let overdue = 0;
    for (const row of due) {
      if (row.state === 'OVERDUE') overdue += 1;
      else dueSoon += 1;
      try {
        await this.alertQueue.add('alert.maintenance_due', {
          scheduleId: row.scheduleId,
          vehicleId: row.vehicleId,
          name: row.name,
          state: row.state,
        });
      } catch (err) {
        this.logger.error({ err, scheduleId: row.scheduleId }, 'Failed to enqueue alert.maintenance_due');
      }
    }
    const result: MaintenanceDueSweepResult = { scanned: due.length, dueSoon, overdue };
    this.logger.log({ jobId: job.id, ...result }, 'maintenance.due sweep processed');
    return result;
  }
}
