import { createHash } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import type { ContextUser } from '../../core/context/request-context';
import { CreateTransferDto } from './dto/transfers.dto';
import { TransfersService } from './transfers.service';
import { validateOutputFile } from './validator';

const ACTOR: ContextUser = { id: 'usr_1', type: 'user', permissions: { reportsTransfer: 'FULL' } };

const DRIVER = {
  id: 'drv_1',
  username: 'jsmith',
  firstName: 'John',
  lastName: 'Smith',
  cdlNumber: 'W8569238',
  cdlState: 'CT',
  homeTerminalTimezone: 'America/New_York',
  hosRuleset: 'US_70_8_PROPERTY',
  eldExempt: false,
  assignedVehicleId: 'veh_1',
} as never;

const CARRIER = {
  id: 'carrier',
  name: 'OneBook Logistics',
  dotNumber: '3355123',
  timezone: 'America/New_York',
  eldIdentifier: 'OBK001',
  eldRegistrationId: null,
  erodsMode: 'TEST',
} as never;

function eldEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    uuid: 'evt-1',
    driverId: 'drv_1',
    vehicleId: 'veh_1',
    eventType: 1,
    eventCode: 3,
    eventSequenceId: 17,
    eventDateTime: new Date('2026-09-08T13:00:00Z'),
    timezoneOffset: -240,
    recordStatus: 1,
    recordOrigin: 1,
    latitude: 41.318511,
    longitude: -72.928932,
    locationPrecisionMi: 1,
    totalVehicleMiles: 120345,
    totalEngineHours: 4321.4,
    distanceSinceLastValidCoords: 0,
    malfunctionCode: null,
    diagnosticCode: null,
    annotation: null,
    comment: null,
    editReason: null,
    editedById: null,
    ...overrides,
  } as never;
}

interface Harness {
  service: TransfersService;
  repo: Record<string, jest.Mock>;
  storage: { put: jest.Mock; get: jest.Mock; delete: jest.Mock; exists: jest.Mock; presignPut: jest.Mock; presignGet: jest.Mock };
  audit: { insert: jest.Mock };
  queue: { add: jest.Mock };
  fmcsa: { assertValidRequest: jest.Mock };
  created: Record<string, unknown>[];
  /** Objects handed to the StoragePort, typed so the specs never index into `any`. */
  puts: { key: string; body: Buffer }[];
  audits: Record<string, unknown>[];
}

function harness(overrides: Partial<Record<string, unknown>> = {}): Harness {
  const created: Record<string, unknown>[] = [];
  const repo = {
    findCarrier: jest.fn().mockResolvedValue(CARRIER),
    findDriver: jest.fn().mockResolvedValue(DRIVER),
    findEvents: jest.fn().mockResolvedValue([eldEvent()]),
    findUnidentifiedEvents: jest.fn().mockResolvedValue([]),
    findDailyLogs: jest.fn().mockResolvedValue([]),
    findPendingUnidentifiedSegments: jest.fn().mockResolvedValue([]),
    findVehicles: jest.fn().mockResolvedValue([{ id: 'veh_1', unitNumber: '101', vin: '1FUJGLDR9CSBK1234' }]),
    findUsers: jest.fn().mockResolvedValue([]),
    findDayTrips: jest.fn().mockResolvedValue([]),
    findDayDetails: jest.fn().mockResolvedValue([]),
    countTransfersInWindow: jest.fn().mockResolvedValue(0),
    createTransfer: jest.fn().mockImplementation(({ data }: never) => data),
    updateTransfer: jest.fn(),
    findTransfer: jest.fn(),
    listTransfers: jest.fn(),
    resolveRequestedByMany: jest.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as unknown as Record<string, jest.Mock>;

  // `createTransfer(data)` in the repository takes the data object directly.
  repo.createTransfer = jest.fn().mockImplementation(async (data: Record<string, unknown>) => {
    created.push(data);
    return { id: 'trf_1', ...data };
  });
  repo.updateTransfer = jest.fn().mockImplementation(async (id: string, data: Record<string, unknown>) => ({
    id,
    ...created[0],
    ...data,
  }));

  const puts: { key: string; body: Buffer }[] = [];
  const audits: Record<string, unknown>[] = [];
  const storage = {
    put: jest.fn().mockImplementation(async (key: string, body: Buffer) => {
      puts.push({ key, body });
      return key;
    }),
    get: jest.fn(),
    delete: jest.fn(),
    exists: jest.fn(),
    presignPut: jest.fn(),
    presignGet: jest.fn(),
  };
  const audit = {
    insert: jest.fn().mockImplementation(async (entry: Record<string, unknown>) => {
      audits.push(entry);
      return {};
    }),
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const fmcsa = { assertValidRequest: jest.fn() };
  const service = new TransfersService(
    repo as never,
    audit as never,
    fmcsa as never,
    storage,
    queue as never,
  );
  return { service, repo, storage, audit, queue, fmcsa, created, puts, audits };
}

const dto = (overrides: Partial<CreateTransferDto> = {}): CreateTransferDto =>
  ({
    driverId: '11111111-1111-1111-1111-111111111111',
    method: 'WEB_SERVICES',
    rangeStart: new Date('2026-09-04T00:00:00Z'),
    rangeEnd: new Date('2026-09-11T00:00:00Z'),
    outputFileComment: 'Roadside inspection',
    ...overrides,
  });

// Appendix A 4.8.2.2(d) puts the creation date in the file name — pin the clock (Date only).
const NOW = new Date('2026-09-11T17:00:00Z'); // 13:00 EDT
const FIRST_NAME = 'SMITH3841091126-000000000.csv';
beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask', 'clearTimeout', 'clearInterval', 'clearImmediate'] });
});
afterAll(() => {
  jest.useRealTimers();
});

describe('TransfersService.create (tz.md §10)', () => {
  it('D-129: header lines 3/4 carry the trailers and shipping documents of today (trip + no-trip day details)', async () => {
    const h = harness({
      findDayTrips: jest.fn().mockResolvedValue([
        {
          id: 't1', number: 'T-1', status: 'IN_PROGRESS', shippingDocument: null, shippingDocuments: ['BOL-TRIP'], trailerNumbers: [],
          trailerNumber: null, bobtail: false, notes: null, plannedStartAt: null, plannedEndAt: null,
          startedAt: new Date('2026-09-11T12:00:00Z'), completedAt: null, createdAt: new Date('2026-09-10T00:00:00Z'),
        },
      ]),
      findDayDetails: jest.fn().mockResolvedValue([
        { logDate: new Date('2026-09-11T00:00:00.000Z'), shippingDocuments: ['BOL-DAY'], trailerNumbers: ['X53-1188'], bobtail: false, notes: null },
      ]),
    });
    await h.service.create(dto(), ACTOR);
    const lines = h.puts[0].body.toString('utf8').split(/\r?\n/);
    expect(lines[3]).toMatch(/^101,1FUJGLDR9CSBK1234,X53-1188,/);
    expect(lines[5]).toMatch(/^BOL-TRIP BOL-DAY,0,/);
    expect(h.repo.findDayDetails).toHaveBeenCalledWith('drv_1', new Date('2026-09-04T00:00:00.000Z'), new Date('2026-09-11T00:00:00.000Z'));
  });

  it('generates, validates and stores an Appendix A file, then queues the send step', async () => {
    const h = harness();
    const view = await h.service.create(dto(), ACTOR);

    expect(h.storage.put).toHaveBeenCalledWith(
      'transfers/trf_1.csv',
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'text/csv' }),
    );
    expect(validateOutputFile(h.puts[0].body.toString('utf8')).valid).toBe(true);
    expect(view.transfer.fileName).toBe(FIRST_NAME);
    expect(view.transfer.status).toBe('QUEUED');
    expect(view.transfer.erodsMode).toBe('TEST');
    expect(h.queue.add).toHaveBeenCalledWith('transfer.send', { transferId: 'trf_1' }, expect.any(Object));
  });

  it('records the sha256 of the stored bytes as the transfer checksum', async () => {
    const h = harness();
    await h.service.create(dto(), ACTOR);
    const body = h.puts[0].body;
    expect(h.created[0].checksum).toBe(createHash('sha256').update(body).digest('hex'));
    expect(h.created[0].fileSizeBytes).toBe(body.length);
  });

  it('surfaces the §10.3 TEST-mode warning without blocking', async () => {
    const h = harness();
    const view = await h.service.create(dto(), ACTOR);
    expect(view.warnings.map((w) => w.code)).toContain('ERODS_TEST_MODE');
  });

  it('surfaces uncertified-log and unresolved-unidentified warnings', async () => {
    const h = harness({
      findPendingUnidentifiedSegments: jest.fn().mockResolvedValue([{ id: 'seg_1' }]),
      findDailyLogs: jest.fn().mockResolvedValue([{ certified: true }, { certified: false }]),
    });
    const view = await h.service.create(dto(), ACTOR);
    expect(view.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['UNRESOLVED_UNIDENTIFIED', 'UNCERTIFIED_LOGS', 'ERODS_TEST_MODE']),
    );
  });

  it('warns about an active malfunction that was logged and never cleared', async () => {
    const h = harness({
      findEvents: jest
        .fn()
        .mockResolvedValue([
          eldEvent(),
          eldEvent({ eventType: 7, eventCode: 1, malfunctionCode: 'P', eventSequenceId: 18 }),
        ]),
    });
    const view = await h.service.create(dto(), ACTOR);
    const finding = view.warnings.find((w) => w.code === 'ACTIVE_MALFUNCTION');
    expect(finding?.details).toMatchObject({ codes: ['P'] });
  });

  it('makes the second file of the same day distinct through the 4.8.2.2(f) suffix', async () => {
    const h = harness({ countTransfersInWindow: jest.fn().mockResolvedValue(1) });
    const view = await h.service.create(dto(), ACTOR);
    expect(view.transfer.fileName).toBe('SMITH3841091126-000000001.csv');
  });

  it('does not put the range day count in the file name (not part of 4.8.2.2)', async () => {
    const h = harness();
    const view = await h.service.create(
      dto({ rangeStart: new Date('2026-09-11T00:00:00Z'), rangeEnd: new Date('2026-09-11T00:00:00Z') }),
      ACTOR,
    );
    expect(view.transfer.fileName).toBe(FIRST_NAME);
  });

  it('rejects a range wider than 8 days with RANGE_TOO_LARGE and stores nothing', async () => {
    const h = harness();
    await expect(
      h.service.create(dto({ rangeStart: new Date('2026-09-01T00:00:00Z') }), ACTOR),
    ).rejects.toMatchObject({ code: 'RANGE_TOO_LARGE' });
    expect(h.storage.put).not.toHaveBeenCalled();
    expect(h.repo.createTransfer).not.toHaveBeenCalled();
  });

  it('rejects an unknown driver with DRIVER_NOT_FOUND', async () => {
    const h = harness({ findDriver: jest.fn().mockResolvedValue(null) });
    await expect(h.service.create(dto(), ACTOR)).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND' });
    expect(h.storage.put).not.toHaveBeenCalled();
  });

  it('checks the email recipient before doing any work', async () => {
    const h = harness();
    h.fmcsa.assertValidRequest.mockImplementation(() => {
      throw AppException.unprocessable('INVALID_TRANSFER_RECIPIENT', 'nope');
    });
    await expect(h.service.create(dto({ method: 'EMAIL', recipient: 'x@gmail.com' }), ACTOR)).rejects.toMatchObject({
      code: 'INVALID_TRANSFER_RECIPIENT',
    });
    expect(h.repo.findEvents).not.toHaveBeenCalled();
  });

  it('writes an AuditLog entry naming the file and the eRODS mode', async () => {
    const h = harness();
    await h.service.create(dto(), ACTOR);
    expect(h.audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ERODS_TRANSFER_REQUESTED',
        objectType: 'DataTransfer',
        objectId: 'trf_1',
        actorId: 'usr_1',
      }),
    );
    expect(h.audits[0].after).toMatchObject({ fileName: FIRST_NAME, erodsMode: 'TEST' });
  });

  it('still returns the stored transfer when the queue is down (the file is not lost)', async () => {
    const h = harness();
    h.queue.add.mockRejectedValue(new Error('redis down'));
    const view = await h.service.create(dto(), ACTOR);
    expect(view.transfer.fileKey).toBe('transfers/trf_1.csv');
  });

  it('carries the email recipient on the transfer row for the worker', async () => {
    const h = harness();
    await h.service.create(dto({ method: 'EMAIL', recipient: 'eldsubmissions@fmcsa.dot.gov' }), ACTOR);
    expect(h.created[0].responseBody).toBe('eldsubmissions@fmcsa.dot.gov');
  });
});

describe('TransfersService.download (§10.1)', () => {
  it('returns the stored CSV under its Appendix A file name and audits the download', async () => {
    const h = harness();
    await h.service.create(dto(), ACTOR);
    const body = h.puts[0].body;
    h.repo.findTransfer.mockResolvedValue({
      id: 'trf_1',
      fileKey: 'transfers/trf_1.csv',
      fileName: 'SMITH38018.csv',
      checksum: createHash('sha256').update(body).digest('hex'),
    });
    h.storage.get.mockResolvedValue(body);

    const result = await h.service.download('trf_1', ACTOR);
    expect(result.fileName).toBe('SMITH38018.csv');
    expect(validateOutputFile(result.csv).valid).toBe(true);
    expect(h.audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ERODS_TRANSFER_DOWNLOADED', objectId: 'trf_1' }),
    );
  });

  it('refuses to serve a file whose bytes no longer match the stored checksum', async () => {
    const h = harness();
    h.repo.findTransfer.mockResolvedValue({
      id: 'trf_1',
      fileKey: 'transfers/trf_1.csv',
      fileName: 'SMITH38018.csv',
      checksum: 'deadbeef',
    });
    h.storage.get.mockResolvedValue(Buffer.from('tampered'));
    await expect(h.service.download('trf_1', ACTOR)).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });

  it('refuses to serve a stored file that no longer conforms to Appendix A', async () => {
    const h = harness();
    const junk = Buffer.from('not,an,eld,file\r\n');
    h.repo.findTransfer.mockResolvedValue({
      id: 'trf_1',
      fileKey: 'transfers/trf_1.csv',
      fileName: 'SMITH38018.csv',
      checksum: createHash('sha256').update(junk).digest('hex'),
    });
    h.storage.get.mockResolvedValue(junk);
    await expect(h.service.download('trf_1', ACTOR)).rejects.toMatchObject({ code: 'OUTPUT_FILE_INVALID' });
  });

  it('404s for an unknown transfer id', async () => {
    const h = harness();
    h.repo.findTransfer.mockResolvedValue(null);
    await expect(h.service.download('nope', ACTOR)).rejects.toBeInstanceOf(AppException);
  });
});
