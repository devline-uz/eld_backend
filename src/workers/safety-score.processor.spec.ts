/** D-133 — nightly W-10 scorecard processor: self-scheduling, worker-only, skipped under test. */
import type { Job, Queue } from 'bullmq';
import type { AppConfigService } from '../core/config/config.service';
import { QUEUES } from '../core/queue/queue.constants';
import type { SafetyScoreService } from '../modules/safety/safety-score.service';
import { SAFETY_SCORE_CRON, SAFETY_SCORE_JOB_NAME, SAFETY_SCORE_REPEAT_JOB_ID, SafetyScoreProcessor } from './safety-score.processor';

function build(isTest = false) {
  const scores = { run: jest.fn(async () => ({})) };
  const queue = { add: jest.fn(async () => ({ id: 'repeat' })) };
  const processor = new SafetyScoreProcessor(
    scores as unknown as SafetyScoreService,
    { isTest } as unknown as AppConfigService,
    queue as unknown as Queue,
  );
  return { processor, scores, queue };
}

describe('SafetyScoreProcessor', () => {
  it('runs on its own queue, nightly at 10:30 UTC', () => {
    expect(QUEUES.SAFETY_SCORE).toBe('safety-score');
    expect(SAFETY_SCORE_CRON).toBe('30 10 * * *');
  });

  it('schedules one repeatable job with a fixed key', async () => {
    const { processor, queue } = build();
    await processor.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      SAFETY_SCORE_JOB_NAME,
      {},
      expect.objectContaining({ repeat: { pattern: SAFETY_SCORE_CRON, tz: 'UTC' }, jobId: SAFETY_SCORE_REPEAT_JOB_ID }),
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

  it('passes an explicit endDate through (backfill / one-off run), else lets the service pick', async () => {
    const { processor, scores } = build();
    await processor.process({ id: '1', data: { endDate: '2026-10-10' } } as Job<{ endDate?: string }>);
    expect(scores.run).toHaveBeenLastCalledWith(expect.any(Date), '2026-10-10');
    await processor.process({ id: '2', data: {} } as Job<{ endDate?: string }>);
    expect(scores.run).toHaveBeenLastCalledWith(expect.any(Date), undefined);
  });

  it('ignores a malformed endDate', async () => {
    const { processor, scores } = build();
    await processor.process({ id: '3', data: { endDate: '10/10/2026' } } as Job<{ endDate?: string }>);
    expect(scores.run).not.toHaveBeenCalled();
  });
});
