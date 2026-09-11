/** TZ §8.6 — the nightly drift processor: self-scheduling, worker-only, idempotent. */
import type { Job, Queue } from 'bullmq';
import type { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import type { DriftSweepResult, HosDriftService } from '../modules/hos-state/hos-drift.service';
import { HosDriftProcessor, HOS_DRIFT_CRON, HOS_DRIFT_JOB_NAME, HOS_DRIFT_REPEAT_JOB_ID } from './hos-drift.processor';

const sweep = (over: Partial<DriftSweepResult> = {}): DriftSweepResult => ({
  scanned: 2,
  compared: 2,
  skippedVersion: 0,
  drifted: 0,
  failed: 0,
  hosEngineVersion: '1.0.0',
  driverIds: [],
  ...over,
});

function build(isTest = false) {
  const drift = { runNightlySweep: jest.fn(async () => sweep()) };
  const config = { isTest };
  const queue = { add: jest.fn(async () => ({ id: 'repeat' })) };
  const processor = new HosDriftProcessor(
    drift as unknown as HosDriftService,
    config as unknown as AppConfigService,
    queue as unknown as Queue,
  );
  return { processor, drift, queue };
}

describe('HosDriftProcessor', () => {
  it('runs on its own queue', () => {
    expect(QUEUES.HOS_DRIFT).toBe('hos-drift');
  });

  it('schedules one nightly repeatable job with a fixed key', async () => {
    const { processor, queue } = build();
    await processor.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      HOS_DRIFT_JOB_NAME,
      {},
      expect.objectContaining({
        repeat: { pattern: HOS_DRIFT_CRON, tz: 'UTC' },
        jobId: HOS_DRIFT_REPEAT_JOB_ID,
      }),
    );
  });

  it('does not schedule anything under NODE_ENV=test', async () => {
    const { processor, queue } = build(true);
    await processor.onModuleInit();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('starts even when Redis is unreachable at boot', async () => {
    const { processor, queue } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(processor.onModuleInit()).resolves.toBeUndefined();
  });

  it('runs the sweep and returns its result', async () => {
    const { processor, drift } = build();
    const result = await processor.process({ id: '1' } as Job);
    expect(drift.runNightlySweep).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 2, drifted: 0 });
  });

  it('reports drifting drivers from the sweep', async () => {
    const { processor, drift } = build();
    drift.runNightlySweep.mockResolvedValueOnce(sweep({ drifted: 1, driverIds: ['d1'], skippedVersion: 3 }));
    const result = await processor.process({ id: '2' } as Job);
    expect(result.drifted).toBe(1);
    expect(result.skippedVersion).toBe(3);
  });

  it('runs the cron nightly at 03:20 UTC', () => {
    expect(HOS_DRIFT_CRON).toBe('20 3 * * *');
  });
});
