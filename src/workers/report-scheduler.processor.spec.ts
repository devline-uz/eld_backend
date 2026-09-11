import { ReportSchedulerProcessor } from './report-scheduler.processor';

describe('ReportSchedulerProcessor.runTick (TZ §15 — report scheduler runs without a manual trigger)', () => {
  function build() {
    const prisma = { report: { create: jest.fn(async (args: { data: object }) => ({ id: 'rpt_1', ...args.data })) } };
    const schedulesRepo = {
      dueSchedules: jest.fn(async () => [
        {
          id: 'sch_1',
          reportType: 'ACTIVITY',
          format: 'CSV',
          params: { from: '2026-09-01', to: '2026-09-08' },
          cron: '0 6 * * 1',
          timezone: 'UTC',
          createdById: 'usr_1',
          enabled: true,
        },
      ]),
      update: jest.fn(async () => undefined),
    };
    const reportsService = { computeNextRun: jest.fn(() => new Date('2026-09-21T06:00:00.000Z')) };
    const config = { isTest: true };
    const tickQueue = { add: jest.fn(async () => undefined) };
    const queue = { add: jest.fn(async () => undefined) };
    const processor = new ReportSchedulerProcessor(
      prisma as never,
      schedulesRepo as never,
      reportsService as never,
      config as never,
      tickQueue as never,
      queue as never,
    );
    return { processor, prisma, schedulesRepo, reportsService, queue };
  }

  it('enqueues a report.generate job for every due schedule and advances nextRunAt', async () => {
    const { processor, prisma, schedulesRepo, queue } = build();
    const now = new Date('2026-09-14T06:00:00.000Z');

    const result = await processor.runTick(now);

    expect(result).toEqual({ due: 1, enqueued: 1 });
    const [createArgs] = prisma.report.create.mock.calls[0] as [{ data: { type: string; format: string; requestedById: string } }];
    expect(createArgs.data).toMatchObject({ type: 'ACTIVITY', format: 'CSV', requestedById: 'usr_1' });
    const [, , addOptions] = queue.add.mock.calls[0] as [string, unknown, { jobId: string }];
    expect(queue.add).toHaveBeenCalledWith('report.generate', { reportId: 'rpt_1' }, expect.anything());
    expect(addOptions.jobId).toBe('report-rpt_1');
    expect(schedulesRepo.update).toHaveBeenCalledWith(
      { id: 'sch_1' },
      { lastRunAt: now, nextRunAt: new Date('2026-09-21T06:00:00.000Z') },
    );
  });

  it('does nothing when no schedule is due', async () => {
    const { processor, schedulesRepo, queue } = build();
    schedulesRepo.dueSchedules.mockResolvedValueOnce([]);
    const result = await processor.runTick(new Date());
    expect(result).toEqual({ due: 0, enqueued: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not let one failing schedule block the others', async () => {
    const { processor, prisma, schedulesRepo, queue } = build();
    schedulesRepo.dueSchedules.mockResolvedValueOnce([
      { id: 'sch_bad', reportType: 'IFTA', format: 'CSV', params: {}, cron: '0 6 * * 1', timezone: 'UTC', createdById: 'usr_1', enabled: true },
      { id: 'sch_ok', reportType: 'ACTIVITY', format: 'CSV', params: {}, cron: '0 6 * * 1', timezone: 'UTC', createdById: 'usr_1', enabled: true },
    ]);
    prisma.report.create.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ id: 'rpt_2' });
    const result = await processor.runTick(new Date());
    expect(result).toEqual({ due: 2, enqueued: 1 });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });
});
