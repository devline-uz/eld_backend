import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { ReportsService } from './reports.service';

describe('ReportsService (TZ §15)', () => {
  const actor: ContextUser = { id: 'usr_1', type: 'user' };

  function build() {
    const repo = {
      create: jest.fn(async (data: object) => ({ id: 'rpt_1', status: 'QUEUED', ...data })),
      list: jest.fn(async () => ({ items: [], total: 0 })),
      findById: jest.fn(async () => null),
    };
    const schedules = {
      create: jest.fn(async (data: object) => ({ id: 'sch_1', ...data })),
      findById: jest.fn(async () => null),
      update: jest.fn(async (_w: unknown, data: object) => ({ id: 'sch_1', ...data })),
      listAll: jest.fn(async () => []),
    };
    const storage = {
      presignGet: jest.fn(async () => 'https://minio.local/signed'),
    };
    const queue = { add: jest.fn(async () => undefined) };
    const service = new ReportsService(repo as never, schedules as never, storage as never, queue as never);
    return { service, repo, schedules, storage, queue };
  }

  it('generate() persists a QUEUED Report row and enqueues report.generate — never runs inline (§15)', async () => {
    const { service, repo, queue } = build();
    const report = await service.generate({ type: 'IFTA', format: 'CSV', params: { quarter: '2026-Q3' } }, actor);
    expect(report.id).toBe('rpt_1');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'IFTA', format: 'CSV', requestedById: 'usr_1' }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'report.generate',
      { reportId: 'rpt_1' },
      expect.objectContaining({ jobId: 'report-rpt_1' }),
    );
  });

  it('validates queued params against the schema of the report type (§22 DoS regression)', async () => {
    const { service, queue } = build();
    // A 1000-year FMCSA pack used to be queued verbatim: `params` was an open record and only
    // the synchronous preview routes ever parsed it.
    await expect(
      service.generate({ type: 'FMCSA_PACK', format: 'PDF', params: { from: '1900-01-01', to: '2999-12-31' } }, actor),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
    await expect(
      service.generate({ type: 'ACTIVITY', format: 'CSV', params: {} }, actor),
    ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
    expect(queue.add).not.toHaveBeenCalled();

    const ok = await service.generate(
      { type: 'ACTIVITY', format: 'CSV', params: { from: '2026-05-01', to: '2026-05-31' } },
      actor,
    );
    expect(ok.id).toBe('rpt_1');
  });

  it('rejects FMCSA_PACK with a non-PDF format', async () => {
    const { service } = build();
    await expect(service.generate({ type: 'FMCSA_PACK', format: 'CSV', params: {} }, actor)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  });

  it('rejects a non-FMCSA_PACK report requested as PDF', async () => {
    const { service } = build();
    await expect(service.generate({ type: 'IFTA', format: 'PDF', params: {} }, actor)).rejects.toMatchObject({
      code: ERROR_CODES.VALIDATION_FAILED,
    });
  });

  it('download() 409s with REPORT_NOT_READY when the report has not finished', async () => {
    const { service, repo } = build();
    repo.findById.mockResolvedValueOnce({ id: 'rpt_1', status: 'QUEUED', fileKey: null });
    await expect(service.download('rpt_1')).rejects.toMatchObject({ code: ERROR_CODES.REPORT_NOT_READY });
  });

  it('download() returns a fresh 7-day presigned URL once READY', async () => {
    const { service, repo, storage } = build();
    repo.findById.mockResolvedValueOnce({ id: 'rpt_1', status: 'READY', fileKey: 'reports/rpt_1.csv' });
    const result = await service.download('rpt_1');
    expect(result.downloadUrl).toBe('https://minio.local/signed');
    expect(storage.presignGet).toHaveBeenCalledWith('reports/rpt_1.csv', 7 * 24 * 60 * 60);
    expect(result.fileName).toBe('rpt_1.csv');
  });

  it('get() 404s for an unknown report id', async () => {
    const { service } = build();
    await expect(service.get('nope')).rejects.toThrow(AppException);
  });

  it('computeNextRun() rejects an invalid cron expression with INVALID_CRON_EXPRESSION', () => {
    const { service } = build();
    let thrown: unknown;
    try {
      service.computeNextRun('not a cron', 'UTC');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: ERROR_CODES.INVALID_CRON_EXPRESSION });
  });

  it('computeNextRun() resolves the next UTC occurrence of a 5-field cron', () => {
    const { service } = build();
    const from = new Date('2026-09-11T00:00:00.000Z'); // Friday
    const next = service.computeNextRun('0 6 * * 1', 'UTC', from); // every Monday 06:00
    expect(next.toISOString()).toBe('2026-09-14T06:00:00.000Z');
  });

  it('createSchedule() computes nextRunAt from cron/timezone up front (report scheduler runs it without a manual trigger)', async () => {
    const { service, schedules } = build();
    const from = new Date('2026-09-11T00:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(from.getTime());
    await service.createSchedule(
      { reportType: 'ACTIVITY', format: 'CSV', params: {}, cron: '0 6 * * 1', timezone: 'UTC', recipients: [], enabled: true },
      actor,
    );
    const [createArgs] = schedules.create.mock.calls[0] as [{ nextRunAt: Date }];
    expect(createArgs.nextRunAt).toBeInstanceOf(Date);
    jest.restoreAllMocks();
  });
});
