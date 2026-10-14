import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { ReportsService } from './reports.service';

describe('ReportsService (TZ §15)', () => {
  const actor: ContextUser = { id: 'usr_1', type: 'user', permissions: { reports: 'FULL', reportsTransfer: 'READ', dvir: 'READ', safety: 'READ' } };
  /** CODE-016 — `reports` FULL but no `reportsTransfer`. */
  const reportsOnly: ContextUser = { id: 'usr_2', type: 'user', permissions: { reports: 'FULL', reportsTransfer: 'NONE', dvir: 'READ' } };

  function build() {
    const repo = {
      create: jest.fn(async (data: object) => ({ id: 'rpt_1', status: 'QUEUED', ...data })),
      list: jest.fn(async () => ({ items: [], total: 0 })),
      findById: jest.fn(async () => null),
      findByIdWithRequestedBy: jest.fn(async (): Promise<Record<string, unknown> | null> => null),
    };
    const schedules = {
      create: jest.fn(async (data: object) => ({ id: 'sch_1', ...data })),
      findById: jest.fn(async () => null),
      update: jest.fn(async (_w: unknown, data: object) => ({ id: 'sch_1', ...data })),
      listAll: jest.fn(async () => []),
      delete: jest.fn(async () => ({ id: 'sch_1' })),
    };
    const storage = {
      presignGet: jest.fn(async () => 'https://minio.local/signed'),
      get: jest.fn(async () => Buffer.from('a,b\n1,2\n')),
    };
    const queue = { add: jest.fn(async () => undefined) };
    const iftaReportGenerator = {
      summary: jest.fn(async () => ({
        quarter: '2026-Q3',
        unitCount: 0,
        kpis: {
          totalMiles: 0,
          taxableMiles: 0,
          taxablePct: null,
          fuelGal: null,
          receiptCount: null,
          fleetMpg: null,
          fleetMpgPrev: null,
        },
        rows: [],
        totals: { totalMiles: 0, taxableMiles: 0, fuelGal: null, mpg: null, taxDueUsd: null },
      })),
    };
    const activitySummaryGenerator = {
      summary: jest.fn(async () => ({
        kpis: { drivingSec: 0, drivingDeltaPct: null, onDutySec: 0, distanceMi: 0, violations: 0, violationsDelta: null },
        items: [],
        page: 1,
        limit: 25,
        total: 0,
        totalPages: 1,
      })),
    };
    const service = new ReportsService(
      repo as never,
      schedules as never,
      iftaReportGenerator as never,
      activitySummaryGenerator as never,
      storage as never,
      queue as never,
    );
    return { service, repo, schedules, storage, queue, iftaReportGenerator, activitySummaryGenerator };
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

  it('B-48 — allows IFTA/ACTIVITY/DVIR to be requested as PDF, not just CSV', async () => {
    const { service, repo } = build();
    await service.generate({ type: 'IFTA', format: 'PDF', params: { quarter: '2026-Q3' } }, actor);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'IFTA', format: 'PDF' }));
  });

  it('rejects a format outside REPORT_TYPE_FORMATS for the type (e.g. RODS as CSV)', async () => {
    const { service } = build();
    await expect(service.generate({ type: 'RODS', format: 'CSV', params: { from: '2026-09-01', to: '2026-09-08' } }, actor)).rejects.toMatchObject(
      { code: ERROR_CODES.VALIDATION_FAILED },
    );
  });

  it('download() 409s with REPORT_NOT_READY when the report has not finished', async () => {
    const { service, repo } = build();
    repo.findByIdWithRequestedBy.mockResolvedValueOnce({ id: 'rpt_1', status: 'QUEUED', fileKey: null, requestedBy: null });
    await expect(service.download('rpt_1')).rejects.toMatchObject({ code: ERROR_CODES.REPORT_NOT_READY });
  });

  it('download() returns a fresh 7-day presigned URL once READY', async () => {
    const { service, repo, storage } = build();
    repo.findByIdWithRequestedBy.mockResolvedValueOnce({ id: 'rpt_1', status: 'READY', fileKey: 'reports/rpt_1.csv', requestedBy: null });
    const result = await service.download('rpt_1');
    expect(result.downloadUrl).toBe('https://minio.local/signed');
    expect(storage.presignGet).toHaveBeenCalledWith('reports/rpt_1.csv', 7 * 24 * 60 * 60);
    expect(result.fileName).toBe('rpt_1.csv');
  });

  it('file() 409s with REPORT_NOT_READY and never reads storage before READY', async () => {
    const { service, repo, storage } = build();
    repo.findByIdWithRequestedBy.mockResolvedValueOnce({ id: 'rpt_1', status: 'RUNNING', fileKey: null, requestedBy: null });
    await expect(service.file('rpt_1')).rejects.toMatchObject({ code: ERROR_CODES.REPORT_NOT_READY });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('file() returns the stored bytes with the file name and content type (web download through the API)', async () => {
    const { service, repo, storage } = build();
    repo.findByIdWithRequestedBy.mockResolvedValueOnce({ id: 'rpt_1', status: 'READY', fileKey: 'reports/rpt_1.csv', requestedBy: null });
    const csv = await service.file('rpt_1');
    expect(storage.get).toHaveBeenCalledWith('reports/rpt_1.csv');
    expect(csv).toEqual({ fileName: 'rpt_1.csv', contentType: 'text/csv; charset=utf-8', body: Buffer.from('a,b\n1,2\n') });

    repo.findByIdWithRequestedBy.mockResolvedValueOnce({ id: 'rpt_2', status: 'READY', fileKey: 'reports/rpt_2.pdf', requestedBy: null });
    await expect(service.file('rpt_2')).resolves.toMatchObject({ fileName: 'rpt_2.pdf', contentType: 'application/pdf' });
  });

  it('get() 404s for an unknown report id', async () => {
    const { service } = build();
    await expect(service.get('nope')).rejects.toThrow(AppException);
  });

  it('iftaSummary() delegates straight to IftaReportGenerator.summary() (gap B-46 — no separate computation)', async () => {
    const { service, iftaReportGenerator } = build();
    const result = await service.iftaSummary({ quarter: '2026-Q3' });
    expect(iftaReportGenerator.summary).toHaveBeenCalledWith({ quarter: '2026-Q3' });
    expect(result.quarter).toBe('2026-Q3');
  });

  it('activitySummary() delegates straight to ActivitySummaryGenerator.summary() (gap B-46 — no fan-out per driver)', async () => {
    const { service, activitySummaryGenerator } = build();
    const params = { from: '2026-09-01', to: '2026-09-08', sort: 'name:asc', page: 1, limit: 25 } as never;
    const result = await service.activitySummary(params);
    expect(activitySummaryGenerator.summary).toHaveBeenCalledWith(params);
    expect(result.items).toEqual([]);
    expect(result.kpis.drivingDeltaPct).toBeNull();
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
      { reportType: 'ACTIVITY', format: 'CSV', params: { window: 'PREVIOUS_WEEK' }, cron: '0 6 * * 1', timezone: 'UTC', recipients: [], enabled: true },
      actor,
    );
    const [createArgs] = schedules.create.mock.calls[0] as [{ nextRunAt: Date }];
    expect(createArgs.nextRunAt).toBeInstanceOf(Date);
    jest.restoreAllMocks();
  });
  describe('CODE-016 — FMCSA pack needs reportsTransfer READ on every route', () => {
    it('generate() refuses FMCSA_PACK without reportsTransfer, nothing queued', async () => {
      const { service, queue } = build();
      await expect(
        service.generate({ type: 'FMCSA_PACK', format: 'PDF', params: { from: '2026-09-01', to: '2026-09-08' } }, reportsOnly),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect(queue.add).not.toHaveBeenCalled();
      await expect(
        service.generate({ type: 'FMCSA_PACK', format: 'PDF', params: { from: '2026-09-01', to: '2026-09-08' } }, actor),
      ).resolves.toMatchObject({ id: 'rpt_1' });
    });

    it('get/download/file of an FMCSA pack are refused without reportsTransfer; other reports are not', async () => {
      const { service, repo } = build();
      repo.findByIdWithRequestedBy.mockResolvedValue({ id: 'rpt_9', type: 'FMCSA_PACK', status: 'READY', fileKey: 'r/p.pdf', requestedBy: null });
      await expect(service.get('rpt_9', reportsOnly)).rejects.toMatchObject({ status: 403 });
      await expect(service.download('rpt_9', reportsOnly)).rejects.toMatchObject({ status: 403 });
      await expect(service.file('rpt_9', reportsOnly)).rejects.toMatchObject({ status: 403 });
      await expect(service.get('rpt_9', actor)).resolves.toMatchObject({ id: 'rpt_9' });
      repo.findByIdWithRequestedBy.mockResolvedValue({ id: 'rpt_8', type: 'IFTA', status: 'READY', fileKey: 'r/i.csv', requestedBy: null });
      await expect(service.get('rpt_8', reportsOnly)).resolves.toMatchObject({ id: 'rpt_8' });
    });

    it('list() hides FMCSA packs from a caller without reportsTransfer', async () => {
      const { service, repo } = build();
      await service.list({ page: 1, limit: 25 }, reportsOnly);
      expect(repo.list).toHaveBeenCalledWith({ type: { notIn: ['FMCSA_PACK', 'SAFETY'] } }, 1, 25);
      repo.list.mockClear();
      await expect(service.list({ page: 1, limit: 25, type: 'FMCSA_PACK' } as never, reportsOnly)).resolves.toMatchObject({ total: 0 });
      expect(repo.list).not.toHaveBeenCalled();
      await service.list({ page: 1, limit: 25 }, actor);
      expect(repo.list).toHaveBeenCalledWith({}, 1, 25);
    });
  });

  describe('CODE-085 — DVIR reports need dvir READ on every route', () => {
    /** The default DISPATCHER: `reports` READ/FULL but `dvir` NONE. */
    const noDvir: ContextUser = { id: 'usr_3', type: 'user', permissions: { reports: 'FULL', reportsTransfer: 'NONE', dvir: 'NONE' } };

    it('generate() refuses DVIR without dvir READ, nothing queued; ACTIVITY still allowed', async () => {
      const { service, queue } = build();
      await expect(
        service.generate({ type: 'DVIR', format: 'CSV', params: { from: '2026-09-01', to: '2026-09-08' } }, noDvir),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      expect(queue.add).not.toHaveBeenCalled();
      await expect(
        service.generate({ type: 'ACTIVITY', format: 'CSV', params: { from: '2026-09-01', to: '2026-09-08' } }, noDvir),
      ).resolves.toMatchObject({ id: 'rpt_1' });
    });

    it('get() of a DVIR report is refused without dvir; list() hides DVIR and FMCSA types', async () => {
      const { service, repo } = build();
      repo.findByIdWithRequestedBy.mockResolvedValue({ id: 'rpt_7', type: 'DVIR', status: 'READY', fileKey: 'r/d.csv', requestedBy: null });
      await expect(service.get('rpt_7', noDvir)).rejects.toMatchObject({ status: 403 });
      await expect(service.get('rpt_7', actor)).resolves.toMatchObject({ id: 'rpt_7' });
      await service.list({ page: 1, limit: 25 }, noDvir);
      expect(repo.list).toHaveBeenCalledWith({ type: { notIn: ['FMCSA_PACK', 'DVIR', 'SAFETY'] } }, 1, 25);
    });

    it('createSchedule() refuses a DVIR schedule without dvir READ', async () => {
      const { service, schedules } = build();
      await expect(
        service.createSchedule(
          { reportType: 'DVIR', format: 'CSV', params: { window: 'PREVIOUS_MONTH' }, cron: '0 6 1 * *', timezone: 'UTC', recipients: [], enabled: true } as never,
          noDvir,
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(schedules.create).not.toHaveBeenCalled();
    });

    it('SAFETY reports need safety READ (get refused, list hides them)', async () => {
      const { service, repo } = build();
      repo.findByIdWithRequestedBy.mockResolvedValue({ id: 'rpt_8', type: 'SAFETY', status: 'READY', fileKey: 'r/s.csv', requestedBy: null });
      await expect(service.get('rpt_8', noDvir)).rejects.toMatchObject({ status: 403 });
      await expect(service.get('rpt_8', actor)).resolves.toMatchObject({ id: 'rpt_8' });
    });

    it('updateSchedule() cannot retarget a schedule to DVIR, nor edit a DVIR one, without dvir READ', async () => {
      const { service, schedules } = build();
      const activity = {
        id: 'sch_1', reportType: 'ACTIVITY', format: 'CSV', params: { window: 'PREVIOUS_WEEK' }, cron: '0 6 * * 1', timezone: 'UTC', enabled: true,
      };
      schedules.findById.mockResolvedValueOnce(activity as never);
      await expect(service.updateSchedule('sch_1', { reportType: 'DVIR' }, noDvir)).rejects.toMatchObject({ status: 403 });
      schedules.findById.mockResolvedValueOnce({ ...activity, reportType: 'DVIR' } as never);
      await expect(service.updateSchedule('sch_1', { enabled: false }, noDvir)).rejects.toMatchObject({ status: 403 });
      expect(schedules.update).not.toHaveBeenCalled();
      schedules.findById.mockResolvedValueOnce(activity as never);
      await expect(service.updateSchedule('sch_1', { enabled: false }, noDvir)).resolves.toMatchObject({ id: 'sch_1' });
    });
  });

  describe('CODE-015 — schedule params validated like generate()', () => {
    const base = { format: 'CSV' as const, cron: '0 6 * * 1', timezone: 'UTC', recipients: [], enabled: true };

    it('createSchedule() refuses params the worker would reject (missing range, oversize range, bad window)', async () => {
      const { service, schedules } = build();
      for (const params of [{}, { from: '1900-01-01', to: '2999-12-31' }, { window: 'LAST_CENTURY' }]) {
        await expect(service.createSchedule({ ...base, reportType: 'ACTIVITY', params }, actor)).rejects.toMatchObject({
          code: ERROR_CODES.VALIDATION_FAILED,
        });
      }
      // A relative window wider than the type allows (FMCSA pack is capped at 62 days).
      await expect(
        service.createSchedule({ ...base, reportType: 'FMCSA_PACK', format: 'PDF', params: { window: 'PREVIOUS_QUARTER' } }, actor),
      ).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
      expect(schedules.create).not.toHaveBeenCalled();
    });

    it('createSchedule() stores the window (not the period it resolved to today) and drops unknown keys', async () => {
      const { service, schedules } = build();
      await service.createSchedule({ ...base, reportType: 'ACTIVITY', params: { window: 'PREVIOUS_MONTH', junk: 1 } }, actor);
      const [data] = schedules.create.mock.calls[0] as unknown as [{ params: Record<string, unknown> }];
      expect(data.params).toEqual({ window: 'PREVIOUS_MONTH' });
    });

    it('updateSchedule() checks a format-only change against the stored type', async () => {
      const { service, schedules } = build();
      schedules.findById.mockResolvedValueOnce({
        id: 'sch_1', reportType: 'FMCSA_PACK', format: 'PDF', params: { window: 'PREVIOUS_MONTH' }, cron: '0 6 1 * *', timezone: 'UTC', enabled: true,
      } as never);
      await expect(service.updateSchedule('sch_1', { format: 'XLSX' }, actor)).rejects.toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED });
      expect(schedules.update).not.toHaveBeenCalled();
    });

    it('updateSchedule() validates new params against the stored type', async () => {
      const { service, schedules } = build();
      schedules.findById.mockResolvedValueOnce({
        id: 'sch_1', reportType: 'ACTIVITY', format: 'CSV', params: { window: 'PREVIOUS_WEEK' }, cron: '0 6 * * 1', timezone: 'UTC', enabled: true,
      } as never);
      await expect(service.updateSchedule('sch_1', { params: { from: '2000-01-01', to: '2026-01-01' } }, actor)).rejects.toMatchObject({
        code: ERROR_CODES.VALIDATION_FAILED,
      });
    });
  });

  describe('schedule management (web Scheduled reports list)', () => {
    const row = {
      id: 'sch_1', reportType: 'IFTA', format: 'PDF', params: {}, cron: '0 6 1 * *', timezone: 'UTC',
      recipients: ['ops@example.com'], enabled: false, lastRunAt: null, nextRunAt: new Date('2020-01-01T06:00:00.000Z'), createdById: 'u1',
    };

    it('deleteSchedule() removes an existing schedule', async () => {
      const { service, schedules } = build();
      schedules.findById.mockResolvedValueOnce(row as never);
      await service.deleteSchedule('sch_1');
      expect(schedules.delete).toHaveBeenCalledWith({ id: 'sch_1' });
    });

    it('deleteSchedule() throws 404 for an unknown schedule and deletes nothing', async () => {
      const { service, schedules } = build();
      await expect(service.deleteSchedule('missing')).rejects.toThrow('Report schedule not found.');
      expect(schedules.delete).not.toHaveBeenCalled();
    });

    it('updateSchedule() resuming a paused schedule recomputes a future nextRunAt', async () => {
      const { service, schedules } = build();
      schedules.findById.mockResolvedValueOnce(row as never);
      await service.updateSchedule('sch_1', { enabled: true }, actor);
      const [, data] = schedules.update.mock.calls[0] as unknown as [unknown, { enabled: boolean; nextRunAt: Date }];
      expect(data.enabled).toBe(true);
      expect(data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('updateSchedule() pausing keeps nextRunAt untouched', async () => {
      const { service, schedules } = build();
      schedules.findById.mockResolvedValueOnce({ ...row, enabled: true } as never);
      await service.updateSchedule('sch_1', { enabled: false }, actor);
      const [, data] = schedules.update.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
      expect(data).toEqual({ enabled: false });
    });
  });
});
