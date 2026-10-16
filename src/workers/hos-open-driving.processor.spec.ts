/** The open-driving sweep: violations that accrue with the clock alone must reach `HosViolation`. */
import type { Job, Queue } from 'bullmq';
import type { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import type { HosRecalcRepository, OpenDrivingRow } from '../modules/hos-recalc/hos-recalc.repository';
import {
  HOS_OPEN_DRIVING_CRON,
  HOS_OPEN_DRIVING_JOB_NAME,
  HOS_OPEN_DRIVING_REPEAT_JOB_ID,
  HosOpenDrivingProcessor,
  openDrivingFromDate,
  staleRecalcJobId,
} from './hos-open-driving.processor';

const NOW = new Date('2026-10-11T10:00:00Z');

function build(rows: OpenDrivingRow[] = [], isTest = false) {
  const repo = { findOpenDrivingDrivers: jest.fn(async () => rows) };
  const config = { isTest };
  const queue = { add: jest.fn(async () => ({ id: 'repeat' })) };
  const recalcQueue = { add: jest.fn(async () => ({ id: 'job' })) };
  const processor = new HosOpenDrivingProcessor(
    repo as unknown as HosRecalcRepository,
    config as unknown as AppConfigService,
    queue as unknown as Queue,
    recalcQueue as unknown as Queue,
  );
  return { processor, repo, queue, recalcQueue };
}

describe('HosOpenDrivingProcessor', () => {
  it('runs on its own queue', () => {
    expect(QUEUES.HOS_OPEN_DRIVING).toBe('hos-open-driving');
  });

  it('schedules one repeatable job with a fixed key', async () => {
    const { processor, queue } = build();
    await processor.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      HOS_OPEN_DRIVING_JOB_NAME,
      {},
      expect.objectContaining({ repeat: { pattern: HOS_OPEN_DRIVING_CRON, tz: 'UTC' }, jobId: HOS_OPEN_DRIVING_REPEAT_JOB_ID }),
    );
  });

  it('does not schedule anything under NODE_ENV=test', async () => {
    const { processor, queue } = build([], true);
    await processor.onModuleInit();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues hos.recalc from the day each open DRIVING record began, in the home-terminal zone', async () => {
    const { processor, repo, recalcQueue } = build([
      // 2026-10-08 03:09 ET — the run's violations are filed on the 8th and later.
      { driverId: 'drv_1', homeTerminalTimezone: 'America/New_York', since: new Date('2026-10-08T07:09:00Z') },
      // 2026-10-11 02:00 UTC is still 2026-10-10 in Chicago.
      { driverId: 'drv_2', homeTerminalTimezone: 'America/Chicago', since: new Date('2026-10-11T02:00:00Z') },
    ]);

    const result = await processor.sweep(NOW);

    expect(repo.findOpenDrivingDrivers).toHaveBeenCalledWith(new Date('2026-09-27T10:00:00Z'), NOW);
    // drv_1 has been "driving" for 3 days — past the 16 h stale cap (BUG-002), so it is computed AS OF the cap.
    expect(recalcQueue.add).toHaveBeenCalledWith(
      'hos.recalc',
      { driverId: 'drv_1', fromDate: '2026-10-08', asOf: '2026-10-08T23:09:00.000Z' },
      { jobId: `hos-recalc-stale-drv_1-${Date.parse('2026-10-08T07:09:00Z')}` },
    );
    expect(recalcQueue.add).toHaveBeenCalledWith('hos.recalc', { driverId: 'drv_2', fromDate: '2026-10-10' });
    expect(result).toEqual({ scanned: 2, enqueued: 2 });
  });

  describe('BE-03 — the 16 h stale-status cap (BUG-002)', () => {
    it('recalculates a silent ELD stuck in DRIVING as of the cap, once per stuck record', async () => {
      const row = { driverId: 'drv_s', homeTerminalTimezone: 'UTC', since: new Date('2026-10-10T06:00:00Z') };
      const { processor, recalcQueue } = build([row]);
      await processor.sweep(NOW);
      expect(recalcQueue.add).toHaveBeenCalledTimes(1);
      expect(recalcQueue.add).toHaveBeenCalledWith(
        'hos.recalc',
        { driverId: 'drv_s', fromDate: '2026-10-10', asOf: '2026-10-10T22:00:00.000Z' },
        { jobId: staleRecalcJobId(row) },
      );
      // BullMQ v5 rejects ':' in a custom job id.
      expect(staleRecalcJobId(row)).not.toContain(':');
    });

    it('keeps recalculating live while the DRIVING record is still under the cap', async () => {
      const { processor, recalcQueue } = build([{ driverId: 'drv_ok', homeTerminalTimezone: 'UTC', since: new Date(NOW.getTime() - 16 * 3600 * 1000) }]);
      await processor.sweep(NOW);
      expect(recalcQueue.add).toHaveBeenCalledWith('hos.recalc', { driverId: 'drv_ok', fromDate: '2026-10-10' });
    });
  });

  it('keeps going when one enqueue fails', async () => {
    const { processor, recalcQueue } = build([
      { driverId: 'drv_1', homeTerminalTimezone: 'UTC', since: NOW },
      { driverId: 'drv_2', homeTerminalTimezone: 'UTC', since: NOW },
    ]);
    recalcQueue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(processor.process({ id: 'j1' } as Job)).resolves.toEqual({ scanned: 2, enqueued: 1 });
  });

  it('never recalculates further back than the lookback', () => {
    expect(openDrivingFromDate({ driverId: 'd', homeTerminalTimezone: 'UTC', since: new Date('2026-08-01T00:00:00Z') }, NOW)).toBe('2026-09-27');
  });
});
