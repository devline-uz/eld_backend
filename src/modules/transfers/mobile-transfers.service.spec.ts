import type { ContextUser } from '../../core/context/request-context';
import { MobileTransfersService, toMobileView } from './mobile-transfers.service';

const DRIVER: ContextUser = { id: 'drv_1', type: 'driver' };

function transferRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trf_1',
    driverId: 'drv_1',
    method: 'WEB_SERVICES',
    status: 'QUEUED',
    erodsMode: 'TEST',
    referenceId: null,
    sentAt: null,
    createdAt: new Date('2026-09-10T15:44:00Z'),
    fileName: 'SMITH38018.csv',
    fileKey: 'transfers/trf_1.csv',
    fileSizeBytes: 2048,
    checksum: 'abc',
    encrypted: false,
    outputFileComment: 'ROADSIDE INSPECTION 2026-09-10',
    rangeStart: new Date('2026-09-03T00:00:00Z'),
    rangeEnd: new Date('2026-09-10T00:00:00Z'),
    responseCode: null,
    responseBody: null,
    attempts: 0,
    requestedById: 'drv_1',
    requestedByType: 'DRIVER',
    ...overrides,
  } as never;
}

describe('MobileTransfersService (mobile/tz.md MB-4)', () => {
  const transfers = {
    create: jest.fn().mockResolvedValue({
      transfer: transferRow(),
      warnings: [
        { code: 'ERODS_TEST_MODE', level: 'warning', message: 'test' },
        { code: 'UNCERTIFIED_LOGS', level: 'warning', message: '2 days' },
      ],
      counts: { header: 9, events: 42 },
    }),
  };
  const repo = { listTransfers: jest.fn().mockResolvedValue({ items: [transferRow({ status: 'TEST_ONLY', referenceId: 'ERODS-TEST-1' })], total: 1, page: 1, limit: 5, totalPages: 1 }) };
  const service = new MobileTransfersService(transfers as never, repo as never);

  beforeEach(() => jest.clearAllMocks());

  it('create: forwards to TransfersService.create with driverId = token subject and the driver actor', async () => {
    const dto = { method: 'WEB_SERVICES' as const, rangeStart: new Date('2026-09-03'), rangeEnd: new Date('2026-09-10'), outputFileComment: 'ROADSIDE INSPECTION 2026-09-10' };
    const out = await service.create(DRIVER, dto);
    expect(transfers.create).toHaveBeenCalledWith({ ...dto, driverId: 'drv_1' }, DRIVER);
    expect(out).toMatchObject({
      id: 'trf_1',
      status: 'QUEUED',
      referenceId: null,
      sentAt: null,
      fileName: 'SMITH38018.csv',
      warnings: ['ERODS_TEST_MODE', 'UNCERTIFIED_LOGS'],
      counts: { header: 9, events: 42 },
    });
    // Storage internals never leak to the app.
    expect(out).not.toHaveProperty('fileKey');
    expect(out).not.toHaveProperty('checksum');
  });

  it('create: a driverId in the body can never override the token subject', async () => {
    const dto = { method: 'WEB_SERVICES', rangeStart: new Date(), rangeEnd: new Date(), outputFileComment: '', driverId: 'drv_OTHER' } as never;
    await service.create(DRIVER, dto);
    const [forwarded] = transfers.create.mock.calls[0] as [{ driverId: string }];
    expect(forwarded.driverId).toBe('drv_1');
  });

  it('create: pre-send errors from the shared path propagate untouched', async () => {
    transfers.create.mockRejectedValueOnce(Object.assign(new Error('range'), { code: 'RANGE_TOO_LARGE', status: 422 }));
    await expect(service.create(DRIVER, { method: 'WEB_SERVICES', rangeStart: new Date(), rangeEnd: new Date(), outputFileComment: '' })).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' });
  });

  it('list: scopes to the driver id from the token, page 1, limit from the query', async () => {
    const out = await service.list(DRIVER, { limit: 5 });
    expect(repo.listTransfers).toHaveBeenCalledWith({ driverId: 'drv_1' }, 1, 5);
    expect(out.items[0]).toMatchObject({ id: 'trf_1', status: 'TEST_ONLY', referenceId: 'ERODS-TEST-1', fileName: 'SMITH38018.csv', outputFileComment: 'ROADSIDE INSPECTION 2026-09-10' });
    expect(out.items[0]).not.toHaveProperty('fileKey');
    expect(out).toMatchObject({ total: 1, limit: 5 });
  });

  it('toMobileView keeps exactly the documented keys', () => {
    expect(Object.keys(toMobileView(transferRow())).sort()).toEqual(
      ['createdAt', 'erodsMode', 'fileName', 'id', 'method', 'outputFileComment', 'rangeEnd', 'rangeStart', 'referenceId', 'sentAt', 'status'].sort(),
    );
  });
});
