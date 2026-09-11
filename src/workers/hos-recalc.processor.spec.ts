/** TZ §8.4 — the `hos.recalc` BullMQ processor. */
import type { Job } from 'bullmq';
import { HosRecalcService, type HosRecalcJobData } from '../modules/hos-recalc/hos-recalc.service';
import { HosRecalcProcessor } from './hos-recalc.processor';

const job = (data: Partial<HosRecalcJobData>, id = 'job-1'): Job<HosRecalcJobData> =>
  ({ id, data } as unknown as Job<HosRecalcJobData>);

describe('HosRecalcProcessor', () => {
  let recalc: { recalculate: jest.Mock };
  let processor: HosRecalcProcessor;

  beforeEach(() => {
    recalc = {
      recalculate: jest.fn().mockResolvedValue({ driverId: 'driver-1', hosEngineVersion: '1.0.0', days: ['2025-01-14'], upserted: 1, autoCleared: 0, refreshed: 0, state: null }),
    };
    processor = new HosRecalcProcessor(recalc as unknown as HosRecalcService);
  });

  it('passes the job payload straight to the service', async () => {
    await processor.process(job({ driverId: 'driver-1', fromDate: '2025-01-14' }));
    expect(recalc.recalculate).toHaveBeenCalledWith({ driverId: 'driver-1', fromDate: '2025-01-14' });
  });

  it('accepts the ingest payload shape', async () => {
    await processor.process(job({ driverId: 'driver-1', from: '2025-01-14T05:00:00Z', to: '2025-01-14T09:00:00Z' }));
    expect(recalc.recalculate).toHaveBeenCalledTimes(1);
  });

  it('drops a job with no driverId instead of throwing', async () => {
    await expect(processor.process(job({}))).resolves.toBeUndefined();
    expect(recalc.recalculate).not.toHaveBeenCalled();
  });

  it('is idempotent — the same job twice calls the same idempotent service path', async () => {
    await processor.process(job({ driverId: 'driver-1' }));
    await processor.process(job({ driverId: 'driver-1' }));
    expect(recalc.recalculate).toHaveBeenCalledTimes(2);
    expect(recalc.recalculate.mock.calls[0]).toEqual(recalc.recalculate.mock.calls[1]);
  });

  it('lets a failure bubble up so BullMQ can retry it', async () => {
    recalc.recalculate.mockRejectedValueOnce(new Error('db down'));
    await expect(processor.process(job({ driverId: 'driver-1' }))).rejects.toThrow('db down');
  });
});
