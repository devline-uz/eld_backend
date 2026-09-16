/**
 * TZ §9 — RODS service behaviour that §395 pins down:
 *   a carrier edit is a proposal and applies nothing until the driver accepts (§395.30(c)(1));
 *   driving time is never shortened or restatused (§395.30(c)(2));
 *   any change to a log invalidates its certification (§395.22(i));
 *   every edit and certification lands in the audit trail (TZ §18).
 */
import type { AppendRow } from './edit-plan';
import { LogsService } from './logs.service';
import type { LogsRepository } from './logs.repository';
import type { RodsEventWriter } from './rods-event-writer';
import type { AuditRepository } from '../audit/audit.repository';
import type { EventBusService } from '../../core/events/event-bus.service';

const TZ = 'America/New_York';
const DRIVER = 'driver-1';

interface FakeEvent {
  id: bigint;
  driverId: string | null;
  vehicleId: string | null;
  deviceId: string | null;
  eventType: number;
  eventCode: number;
  eventDateTime: Date;
  recordStatus: number;
  recordOrigin: number;
  eventSequenceId: number;
  supersedesId: bigint | null;
  annotation: string | null;
  comment: string | null;
  editedById: string | null;
  editorType: string | null;
  editReason: string | null;
  totalVehicleMiles: number | null;
  locationName: string | null;
  createdAt: Date;
}

function evt(partial: Partial<FakeEvent> & { id: bigint; at: string; code: number }): FakeEvent {
  return {
    id: partial.id,
    driverId: partial.driverId === undefined ? DRIVER : partial.driverId,
    vehicleId: 'veh-1',
    deviceId: 'dev-1',
    eventType: partial.eventType ?? 1,
    eventCode: partial.code,
    eventDateTime: new Date(partial.at),
    recordStatus: partial.recordStatus ?? 1,
    recordOrigin: partial.recordOrigin ?? 1,
    eventSequenceId: partial.eventSequenceId ?? Number(partial.id),
    supersedesId: partial.supersedesId ?? null,
    annotation: partial.annotation ?? null,
    comment: partial.comment ?? null,
    editedById: partial.editedById ?? null,
    editorType: partial.editorType ?? null,
    editReason: partial.editReason ?? null,
    totalVehicleMiles: partial.totalVehicleMiles ?? null,
    locationName: null,
    createdAt: new Date(partial.at),
  };
}

class FakeRepo {
  driver: Record<string, unknown> | null = {
    id: DRIVER,
    username: 'jsmith',
    homeTerminalTimezone: TZ,
    assignedVehicleId: 'veh-1',
  };
  events: FakeEvent[] = [];
  dailyLogs = new Map<string, Record<string, unknown>>();
  invalidated: string[] = [];

  findDriver = jest.fn(async () => this.driver);
  findEvents = jest.fn(async (_id: string, from: Date, to: Date) =>
    this.events.filter((e) => e.eventDateTime >= from && e.eventDateTime <= to),
  );
  findEventById = jest.fn(async (id: bigint) => this.events.find((e) => e.id === id) ?? null);
  findSupersedingEvents = jest.fn(async (ids: bigint[]) =>
    this.events.filter((e) => e.supersedesId !== null && ids.includes(e.supersedesId)),
  );
  findEditRequests = jest.fn(async () => this.events.filter((e) => e.recordStatus === 3));
  findViolations = jest.fn(async () => []);
  findUnidentifiedSegments = jest.fn(async () => []);
  findVehicleIdsForDriver = jest.fn(async () => ['veh-1']);
  findDailyLog = jest.fn(async (_id: string, date: Date) => this.dailyLogs.get(date.toISOString()) ?? null);
  findDailyLogs = jest.fn(async () => [...this.dailyLogs.values()]);
  findUncertifiedDates = jest.fn(async (): Promise<Date[]> => []);

  upsertDailyLog = jest.fn(async (args: Record<string, unknown>) => {
    const key = (args.logDate as Date).toISOString();
    const row = { certified: false, certificationCount: 0, hasViolation: false, violationCount: 0, id: `log-${key}`, ...(this.dailyLogs.get(key) ?? {}), ...args };
    this.dailyLogs.set(key, row);
    return row;
  });

  invalidateCertification = jest.fn(async (_driverId: string, date: Date) => {
    const key = date.toISOString();
    this.invalidated.push(key);
    const row = { id: `log-${key}`, certificationCount: 0, ...(this.dailyLogs.get(key) ?? {}), certified: false, hasEdits: true };
    this.dailyLogs.set(key, row);
    return row;
  });

  certify = jest.fn(async (args: { logDate: Date; certifierType: string }) => {
    const key = args.logDate.toISOString();
    const previous = this.dailyLogs.get(key) ?? {};
    const row = {
      id: `log-${key}`,
      ...previous,
      certified: true,
      certifiedAt: new Date('2026-06-05T12:00:00Z'),
      certifierType: args.certifierType,
      certificationCount: ((previous.certificationCount as number) ?? 0) + 1,
    };
    this.dailyLogs.set(key, row);
    return row;
  });

  runInTransaction = jest.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({}));
}

class FakeWriter {
  calls: Array<{ ctx: Record<string, unknown>; rows: AppendRow[] }> = [];
  nextId = 100n;
  append = jest.fn(async (_tx: unknown, ctx: Record<string, unknown>, rows: AppendRow[]) => {
    this.calls.push({ ctx, rows });
    const map = new Map<string, bigint>();
    rows.forEach((row, index) => {
      map.set(`${row.kind}:${index}`, this.nextId);
      this.nextId += 1n;
    });
    return map;
  });

  get rows(): AppendRow[] {
    return this.calls.flatMap((call) => call.rows);
  }
}

function build() {
  const repo = new FakeRepo();
  const writer = new FakeWriter();
  const audit = { insert: jest.fn(async () => ({})) };
  const events = { publish: jest.fn(async () => undefined) };
  const hosQueue = { add: jest.fn(async () => ({})) };
  const alertQueue = { add: jest.fn(async () => ({})) };
  const service = new LogsService(
    repo as unknown as LogsRepository,
    writer as unknown as RodsEventWriter,
    audit as unknown as AuditRepository,
    events as unknown as EventBusService,
    hosQueue as never,
    alertQueue as never,
  );
  return { service, repo, writer, audit, events, hosQueue, alertQueue };
}

const carrier = { id: 'user-1', type: 'user' as const, permissions: { hosEdit: 'FULL' as const } };
const driver = { id: DRIVER, type: 'driver' as const };

describe('§395.30 — a carrier edit is a proposal, never an applied change', () => {
  it('stores the proposal with recordStatus 3 and writes nothing active', async () => {
    const { service, repo, writer, audit } = build();
    repo.events = [evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 4 }), evt({ id: 2n, at: '2026-06-01T14:00:00Z', code: 1 })];

    const result = await service.createEditRequest(
      DRIVER,
      {
        originalEventId: '1',
        proposedStatus: 'SB',
        proposedStart: new Date('2026-06-01T12:00:00Z'),
        proposedEnd: new Date('2026-06-01T14:00:00Z'),
        reason: 'Driver was in the sleeper',
      },
      carrier,
    );

    expect(result.applied).toBe(false);
    expect(result.status).toBe('PENDING');
    expect(writer.rows).toHaveLength(1);
    expect(writer.rows[0]).toMatchObject({ recordStatus: 3, recordOrigin: 3, supersedesId: 1n });
    // Nothing was applied: no certification was invalidated and no recalc was queued.
    expect(repo.invalidated).toEqual([]);
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOG_EDIT_REQUESTED' }));
  });

  it('refuses to shorten driving time with 422 DRIVING_TIME_IMMUTABLE', async () => {
    const { service, repo } = build();
    repo.events = [evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 3 }), evt({ id: 2n, at: '2026-06-01T15:00:00Z', code: 1 })];

    await expect(
      service.createEditRequest(
        DRIVER,
        {
          originalEventId: '1',
          proposedStatus: 'D',
          proposedStart: new Date('2026-06-01T13:00:00Z'),
          reason: 'Trim the drive',
        },
        carrier,
      ),
    ).rejects.toMatchObject({ code: 'DRIVING_TIME_IMMUTABLE', status: 422 });
  });

  it('refuses to restatus driving time', async () => {
    const { service, repo } = build();
    repo.events = [evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 3 }), evt({ id: 2n, at: '2026-06-01T15:00:00Z', code: 1 })];

    await expect(
      service.createEditRequest(
        DRIVER,
        {
          originalEventId: '1',
          proposedStatus: 'ON',
          proposedStart: new Date('2026-06-01T12:00:00Z'),
          reason: 'Was loading, not driving',
        },
        carrier,
      ),
    ).rejects.toMatchObject({ code: 'DRIVING_TIME_IMMUTABLE' });
  });

  it('applies the edit only when the driver accepts, and invalidates certification', async () => {
    const { service, repo, writer, audit, hosQueue } = build();
    const original = evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 4 });
    const request = evt({
      id: 5n,
      at: '2026-06-01T12:00:00Z',
      code: 2,
      recordStatus: 3,
      recordOrigin: 3,
      supersedesId: 1n,
      annotation: 'Driver was in the sleeper',
    });
    repo.events = [original, evt({ id: 2n, at: '2026-06-01T14:00:00Z', code: 1 }), request];

    const result = await service.acceptEditRequest('5', driver, {});

    expect(result).toMatchObject({ status: 'ACCEPTED', applied: true });
    const kinds = writer.rows.map((row) => row.kind);
    expect(kinds).toContain('INACTIVE_MARKER');
    expect(kinds).toContain('NEW_ACTIVE');
    expect(repo.invalidated.length).toBeGreaterThan(0);
    expect(hosQueue.add).toHaveBeenCalledWith('hos.recalc', expect.objectContaining({ driverId: DRIVER }));
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOG_EDIT_ACCEPTED' }));
  });

  it('leaves the log untouched when the driver rejects', async () => {
    const { service, repo, writer, audit, hosQueue } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 4 }),
      evt({ id: 5n, at: '2026-06-01T12:00:00Z', code: 2, recordStatus: 3, recordOrigin: 3, supersedesId: 1n }),
    ];

    const result = await service.rejectEditRequest('5', driver, { note: 'Not correct' });

    expect(result).toMatchObject({ status: 'REJECTED', applied: false });
    expect(writer.rows.map((row) => row.recordStatus)).toEqual([4]);
    expect(repo.invalidated).toEqual([]);
    expect(hosQueue.add).not.toHaveBeenCalled();
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOG_EDIT_REJECTED' }));
  });

  it('refuses a second answer to the same request', async () => {
    const { service, repo } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 4 }),
      evt({ id: 5n, at: '2026-06-01T12:00:00Z', code: 2, recordStatus: 3, supersedesId: 1n }),
      evt({ id: 6n, at: '2026-06-01T12:00:00Z', code: 2, recordStatus: 4, supersedesId: 5n }),
    ];
    await expect(service.rejectEditRequest('5', driver, {})).rejects.toMatchObject({
      code: 'EDIT_ALREADY_RESOLVED',
      status: 409,
    });
  });

  it('never lets a back-office user or API key activate a proposal (§395.30(c)(1) regression)', async () => {
    const { service, repo, writer } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 4 }),
      evt({ id: 5n, at: '2026-06-01T12:00:00Z', code: 2, recordStatus: 3, supersedesId: 1n }),
    ];

    for (const impostor of [
      { id: 'user-1', type: 'user' as const, permissions: { hosEdit: 'FULL' as const } },
      { id: 'key-1', type: 'api-key' as const, permissions: { hosEdit: 'FULL' as const } },
    ]) {
      await expect(service.acceptEditRequest('5', impostor, {})).rejects.toMatchObject({
        code: 'DRIVER_CONTEXT_REQUIRED',
        status: 403,
      });
      await expect(service.rejectEditRequest('5', impostor, {})).rejects.toMatchObject({
        code: 'DRIVER_CONTEXT_REQUIRED',
        status: 403,
      });
    }
    // The proposal is still inert: nothing was appended, so nothing became the active record.
    expect(writer.rows).toHaveLength(0);
  });

  it('lets only the driver whose record it is answer', async () => {
    const { service, repo } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 4 }),
      evt({ id: 5n, at: '2026-06-01T12:00:00Z', code: 2, recordStatus: 3, supersedesId: 1n }),
    ];
    await expect(
      service.acceptEditRequest('5', { id: 'other-driver', type: 'driver' }, {}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});

describe('§9.3 — the driver edits their own log but never the D segment', () => {
  it('adds a forgotten on-duty interval as recordOrigin 2 / recordStatus 1', async () => {
    const { service, repo, writer, audit } = build();
    repo.events = [evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 1 })];

    const result = await service.createLogEntry(
      DRIVER,
      {
        status: 'ON',
        startAt: new Date('2026-06-01T18:00:00Z'),
        endAt: new Date('2026-06-01T18:45:00Z'),
        annotation: 'Loading at shipper #4821',
      },
      driver,
    );

    expect(result).toMatchObject({ recordOrigin: 2, recordStatus: 1, applied: true, recertificationRequired: true });
    expect(writer.rows[0]).toMatchObject({ recordStatus: 1, recordOrigin: 2 });
    expect(repo.invalidated.length).toBeGreaterThan(0);
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOG_SELF_EDIT' }));
  });

  it('refuses a self-edit that lands on driving time', async () => {
    const { service, repo } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 3 }),
      evt({ id: 2n, at: '2026-06-01T15:00:00Z', code: 1 }),
    ];

    await expect(
      service.createLogEntry(
        DRIVER,
        {
          status: 'OFF',
          startAt: new Date('2026-06-01T13:00:00Z'),
          endAt: new Date('2026-06-01T14:00:00Z'),
          annotation: 'I was resting here',
        },
        driver,
      ),
    ).rejects.toMatchObject({ code: 'DRIVING_TIME_IMMUTABLE', status: 422 });
  });

  it('refuses restatusing an existing driving record', async () => {
    const { service, repo } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 3 }),
      evt({ id: 2n, at: '2026-06-01T15:00:00Z', code: 1 }),
    ];

    await expect(
      service.createLogEntry(
        DRIVER,
        {
          status: 'ON',
          startAt: new Date('2026-06-01T12:00:00Z'),
          annotation: 'Was loading, not driving',
          originalEventId: '1',
        },
        driver,
      ),
    ).rejects.toMatchObject({ code: 'DRIVING_TIME_IMMUTABLE' });
  });

  // bugs.md B-049 — ON at 15:00 follows D at 12:00; moving ON to 15:06 must not make 15:00-15:06 driving.
  it('refuses moving the record right after driving LATER (would back-fill the gap with driving)', async () => {
    const { service, repo, writer } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 3 }),
      evt({ id: 2n, at: '2026-06-01T15:00:00Z', code: 4 }),
    ];

    await expect(
      service.createLogEntry(
        DRIVER,
        {
          status: 'ON',
          startAt: new Date('2026-06-01T15:06:00Z'),
          annotation: 'Actually started yard work at 15:06',
          originalEventId: '2',
        },
        driver,
      ),
    ).rejects.toMatchObject({ code: 'DRIVING_TIME_IMMUTABLE', status: 422, details: { reason: 'EXTENDS_DRIVING' } });
    expect(writer.rows.filter((row) => row.eventType === 1 && row.eventCode === 3)).toHaveLength(0);
  });
});

describe('§9.2 — certification', () => {
  it('certifies with event code 1 first and 2 on re-certification, counting truly', async () => {
    const { service, repo, writer, audit } = build();
    repo.events = [evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 1 })];

    const first = await service.certify({ dates: ['2026-06-01'] }, driver);
    expect(first.days[0]).toMatchObject({ eventCode: 1, certificationCount: 1 });

    const second = await service.certify({ dates: ['2026-06-01'] }, driver);
    expect(second.days[0]).toMatchObject({ eventCode: 2, certificationCount: 2 });

    const certificationRows = writer.rows.filter((row) => row.eventType === 4);
    expect(certificationRows.map((row) => row.eventCode)).toEqual([1, 2]);
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOG_CERTIFIED' }));
  });

  it('refuses certify-on-behalf without hosCertifyOnBehalf = FULL', async () => {
    const { service } = build();
    await expect(
      service.certify({ dates: ['2026-06-01'], driverId: DRIVER }, { id: 'user-1', type: 'user', permissions: { hosCertifyOnBehalf: 'READ' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('treats an API-key principal as certify-on-behalf, so it needs the permission too', async () => {
    const { service } = build();
    await expect(
      service.certify({ dates: ['2026-06-01'], driverId: DRIVER }, { id: 'key-1', type: 'api-key', permissions: {} }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('audits certify-on-behalf as its own action', async () => {
    const { service, audit } = build();
    await service.certify(
      { dates: ['2026-06-01'], driverId: DRIVER },
      { id: 'user-1', type: 'user', permissions: { hosCertifyOnBehalf: 'FULL' } },
    );
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOG_CERTIFIED_ON_BEHALF' }));
  });

  it('refuses to certify a day that has not happened yet', async () => {
    const { service } = build();
    await expect(service.certify({ dates: ['2099-01-01'] }, driver)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('raises alert.uncertified_logs at the 8-day threshold', async () => {
    const { service, repo, alertQueue } = build();
    repo.findUncertifiedDates = jest.fn(async () => [new Date('2026-05-20T00:00:00Z')]);
    const fired = await service.checkUncertifiedAlert(DRIVER, TZ, new Date('2026-06-01T12:00:00Z'));
    expect(fired).toBe(true);
    expect(alertQueue.add).toHaveBeenCalledWith('alert.uncertified_logs', expect.objectContaining({ thresholdDays: 8 }));
  });
});

describe('B-050 — recordLogChange: the shared "records changed" hook voids certification (§9.2)', () => {
  it('voids every RODS day in the span, including the next day when it runs past midnight', async () => {
    const { service, repo, events } = build();
    for (const key of ['2026-06-01', '2026-06-02']) {
      repo.dailyLogs.set(`${key}T00:00:00.000Z`, {
        id: `log-${key}`,
        logDate: new Date(`${key}T00:00:00.000Z`),
        certified: true,
        certifiedAt: new Date('2026-06-03T12:00:00Z'),
        certificationCount: 1,
        hasEdits: false,
      });
    }

    // 23:30 → 00:30 New York = 03:30Z → 04:30Z on 2026-06-02.
    const keys = await service.recordLogChange(
      DRIVER,
      TZ,
      new Date('2026-06-02T03:30:00Z'),
      new Date('2026-06-02T04:30:00Z'),
    );

    expect(keys).toEqual(['2026-06-01', '2026-06-02']);
    expect(repo.invalidated).toEqual(['2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z']);
    expect(repo.dailyLogs.get('2026-06-01T00:00:00.000Z')).toMatchObject({ certified: false, hasEdits: true });
    expect(repo.dailyLogs.get('2026-06-02T00:00:00.000Z')).toMatchObject({ certified: false, hasEdits: true });
    expect(events.publish).toHaveBeenCalledWith('log.changed', { driverId: DRIVER, dates: ['2026-06-01', '2026-06-02'] });
  });

  it('voids the days BETWEEN the span ends too (a multi-day interval)', async () => {
    const { service, repo } = build();
    const keys = await service.recordLogChange(
      DRIVER,
      TZ,
      new Date('2026-06-01T12:00:00Z'),
      new Date('2026-06-03T12:00:00Z'),
    );
    expect(keys).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(repo.invalidated).toHaveLength(3);
  });
});

describe('B-059 — every applied record change rebuilds the DailyLog headers it can alter', () => {
  const headerKeys = (repo: FakeRepo) =>
    repo.upsertDailyLog.mock.calls.map((call) => ((call[0] as { logDate: Date }).logDate).toISOString().slice(0, 10));

  it('a driver self-edit rebuilds the edited day and the next day, after invalidating certification', async () => {
    const { service, repo, hosQueue } = build();
    repo.events = [evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 1 })];
    repo.dailyLogs.set('2026-06-01T00:00:00.000Z', { id: 'log-1', certified: true, certificationCount: 1, hasEdits: false, logDate: new Date('2026-06-01T00:00:00Z') });

    await service.createLogEntry(
      DRIVER,
      { status: 'ON', startAt: new Date('2026-06-01T18:00:00Z'), endAt: new Date('2026-06-01T18:45:00Z'), annotation: 'Loading at shipper #4821' },
      driver,
    );

    expect(headerKeys(repo)).toEqual(['2026-06-01', '2026-06-02']);
    expect(repo.upsertDailyLog.mock.invocationCallOrder[0]).toBeGreaterThan(repo.invalidateCertification.mock.invocationCallOrder[0]);
    expect(repo.upsertDailyLog.mock.invocationCallOrder[0]).toBeLessThan(hosQueue.add.mock.invocationCallOrder[0]);
    // The rebuild never re-certifies and keeps the §9.2 edit mark.
    expect(repo.dailyLogs.get('2026-06-01T00:00:00.000Z')).toMatchObject({ certified: false, hasEdits: true });
    for (const call of repo.upsertDailyLog.mock.calls) {
      expect(Object.keys(call[0] as object).some((k) => k.startsWith('certif'))).toBe(false);
    }
  });

  it('an accepted carrier edit rebuilds the touched day and the next day', async () => {
    const { service, repo } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 4 }),
      evt({ id: 2n, at: '2026-06-01T14:00:00Z', code: 1 }),
      evt({ id: 5n, at: '2026-06-01T12:00:00Z', code: 2, recordStatus: 3, recordOrigin: 3, supersedesId: 1n }),
    ];
    await service.acceptEditRequest('5', driver, {});
    expect(headerKeys(repo)).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('a rejected carrier edit changes nothing, so rebuilds nothing', async () => {
    const { service, repo } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 4 }),
      evt({ id: 5n, at: '2026-06-01T12:00:00Z', code: 2, recordStatus: 3, recordOrigin: 3, supersedesId: 1n }),
    ];
    await service.rejectEditRequest('5', driver, {});
    expect(repo.upsertDailyLog).not.toHaveBeenCalled();
  });

  it('a header rebuild failure never fails the committed change; hos.recalc is still queued', async () => {
    const { service, repo, hosQueue } = build();
    repo.events = [evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 1 })];
    repo.upsertDailyLog.mockRejectedValueOnce(new Error('db blip'));
    await expect(
      service.createLogEntry(
        DRIVER,
        { status: 'ON', startAt: new Date('2026-06-01T18:00:00Z'), endAt: new Date('2026-06-01T18:45:00Z'), annotation: 'Fuel stop' },
        driver,
      ),
    ).resolves.toMatchObject({ applied: true });
    expect(hosQueue.add).toHaveBeenCalledWith('hos.recalc', expect.objectContaining({ driverId: DRIVER, fromDate: '2026-06-01' }));
  });

  it('rebuildDailyLogsForSpan never writes a day after today', async () => {
    const { service, repo } = build();
    const now = new Date('2026-06-01T20:00:00Z');
    expect(await service.rebuildDailyLogsForSpan(DRIVER, new Date('2026-06-01T14:00:00Z'), new Date('2026-06-01T15:00:00Z'), now)).toBe(1);
    expect(headerKeys(repo)).toEqual(['2026-06-01']);
    expect(await service.rebuildDailyLogsForSpan(DRIVER, new Date('2026-06-03T14:00:00Z'), new Date('2026-06-03T15:00:00Z'), now)).toBe(0);
  });

  it('rebuildDailyLogsForSpan returns 0 for an unknown driver instead of throwing', async () => {
    const { service, repo } = build();
    repo.driver = null;
    await expect(service.rebuildDailyLogsForSpan('ghost', new Date(), new Date())).resolves.toBe(0);
  });

  it('the log view counts a sleeper berth carried over several midnights as SB (same lookback as hos.recalc)', async () => {
    const { service, repo } = build();
    repo.events = [evt({ id: 1n, at: '2026-05-28T12:00:00Z', code: 2 })];
    const day = await service.getDay(DRIVER, '2026-06-01', new Date('2026-06-10T00:00:00Z'));
    expect(day.summary).toMatchObject({ sleeperSec: 86400, offDutySec: 0 });
  });
});

describe('daily log generation', () => {
  it('persists the day header split by the home terminal timezone', async () => {
    const { service, repo } = build();
    repo.events = [
      evt({ id: 1n, at: '2026-06-01T12:00:00Z', code: 3, totalVehicleMiles: 1000 }),
      evt({ id: 2n, at: '2026-06-01T16:00:00Z', code: 1, totalVehicleMiles: 1240 }),
    ];

    const day = await service.getDay(DRIVER, '2026-06-01', new Date('2026-06-02T12:00:00Z'));

    expect(day.timezone).toBe(TZ);
    expect(day.summary.drivingSec).toBe(4 * 3600);
    expect(day.summary.totalDistanceMi).toBe(240);
    expect(repo.upsertDailyLog).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: TZ, drivingSec: 4 * 3600, totalDistanceMi: 240 }),
    );
  });

  it('404s for an unknown driver', async () => {
    const { service, repo } = build();
    repo.driver = null;
    await expect(service.getDay('nope', '2026-06-01')).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND' });
  });
});
