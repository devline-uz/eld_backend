/**
 * TZ §5.9 / §7.4 / §23 — unidentified driving.
 *   `recordOrigin` stays 1 when a segment is assigned and is NEVER 2;
 *   rejection puts the records back in the pool (origin 4, driverId null);
 *   device-stored records are never lost — nothing is updated or deleted, only appended.
 */
import type { AppendRow } from '../logs/edit-plan';
import type { RodsEventWriter } from '../logs/rods-event-writer';
import type { AuditRepository } from '../audit/audit.repository';
import type { EventBusService } from '../../core/events/event-bus.service';
import type { LogsService } from '../logs/logs.service';
import { UnidentifiedService } from './unidentified.service';
import type { UnidentifiedRepository } from './unidentified.repository';

const DRIVER = 'driver-1';

interface FakeEvent {
  id: bigint;
  driverId: string | null;
  vehicleId: string;
  eventType: number;
  eventCode: number;
  eventDateTime: Date;
  recordStatus: number;
  recordOrigin: number;
  eventSequenceId: number;
  supersedesId: bigint | null;
  wasStoredOnDevice: boolean;
  locationName: string | null;
  totalVehicleMiles: number | null;
}

function poolEvent(id: bigint, at: string, code = 3): FakeEvent {
  return {
    id,
    driverId: null,
    vehicleId: 'veh-1',
    eventType: 1,
    eventCode: code,
    eventDateTime: new Date(at),
    recordStatus: 1,
    recordOrigin: 4,
    eventSequenceId: Number(id),
    supersedesId: null,
    wasStoredOnDevice: true,
    locationName: 'Florence, KY',
    totalVehicleMiles: 1000,
  };
}

class FakeRepo {
  segment: Record<string, unknown> = {
    id: 'seg-1',
    vehicleId: 'veh-1',
    startAt: new Date('2026-06-01T12:00:00Z'),
    endAt: new Date('2026-06-01T13:00:00Z'),
    durationSec: 3600,
    distanceMi: 42,
    status: 'PENDING',
    assignedDriverId: null,
    assignedById: null,
    assignedAt: null,
    annotation: null,
    eventIds: [1n, 2n],
    fromStoredEvents: true,
  };
  events: FakeEvent[] = [poolEvent(1n, '2026-06-01T12:00:00Z'), poolEvent(2n, '2026-06-01T13:00:00Z', 1)];
  driver: Record<string, unknown> | null = { id: DRIVER, username: 'jsmith', homeTerminalTimezone: 'America/New_York' };

  /** §395.32 — driver↔unit association for a self-claim; flipped to false by the IDOR test. */
  associated = true;
  hasDriverVehicleAssociation = jest.fn(async () => this.associated);
  findSegment = jest.fn(async () => this.segment);
  listSegments = jest.fn(async () => ({ items: [this.segment], total: 1, page: 1, limit: 25, totalPages: 1 }));
  findDriver = jest.fn(async () => this.driver);
  findEventsByIds = jest.fn(async (ids: bigint[]) => this.events.filter((e) => ids.includes(e.id)));
  findSupersedingEvents = jest.fn(async (ids: bigint[]) =>
    this.events.filter((e) => e.supersedesId !== null && ids.includes(e.supersedesId)),
  );
  findDriverEventsAfter = jest.fn(async () => []);
  findDriverEventsBefore = jest.fn(async () => []);
  updateSegment = jest.fn(async (_id: string, data: Record<string, unknown>) => {
    this.segment = { ...this.segment, ...data };
    return this.segment;
  });
  runInTransaction = jest.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({}));
}

class FakeWriter {
  calls: Array<{ ctx: Record<string, unknown>; rows: AppendRow[] }> = [];
  append = jest.fn(async (_tx: unknown, ctx: Record<string, unknown>, rows: AppendRow[]) => {
    this.calls.push({ ctx, rows });
    return new Map<string, bigint>();
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
  const logs = { recordLogChange: jest.fn(async () => ['2026-06-01']) };
  const alertQueue = { add: jest.fn(async () => ({})) };
  const service = new UnidentifiedService(
    repo as unknown as UnidentifiedRepository,
    writer as unknown as RodsEventWriter,
    audit as unknown as AuditRepository,
    events as unknown as EventBusService,
    hosQueue as never,
    logs as unknown as LogsService,
    alertQueue as never,
  );
  return { service, repo, writer, audit, events, hosQueue, logs, alertQueue };
}

const actor = { id: 'user-1', type: 'user' as const };

describe('assignment', () => {
  it('keeps recordOrigin = 1 on every attributed record and NEVER writes origin 2', async () => {
    const { service, writer } = build();

    await service.assign('seg-1', { driverId: DRIVER }, actor);

    const attributed = writer.calls.find((call) => call.ctx.driverId === DRIVER);
    expect(attributed).toBeDefined();
    const copies = attributed!.rows.filter((row) => row.kind === 'NEW_ACTIVE');
    expect(copies).toHaveLength(2);
    for (const row of copies) {
      expect(row.recordOrigin).toBe(1);
      expect(row.recordStatus).toBe(1);
    }
    // The §23 invariant, stated as bluntly as the checklist does.
    expect(writer.rows.every((row) => row.recordOrigin !== 2)).toBe(true);
  });

  it('sets status, assignedById and assignedAt on the segment', async () => {
    const { service, repo } = build();
    const view = await service.assign('seg-1', { driverId: DRIVER }, actor);
    expect(view).toMatchObject({ status: 'ASSIGNED', assignedDriverId: DRIVER, assignedById: 'user-1' });
    expect(repo.updateSegment).toHaveBeenCalledWith(
      'seg-1',
      expect.objectContaining({ status: 'ASSIGNED', assignedById: 'user-1' }),
    );
  });

  it('never loses the device-stored records: they are retired by an appended marker, not deleted', async () => {
    const { service, repo, writer } = build();
    const before = repo.events.map((event) => event.id);

    await service.assign('seg-1', { driverId: DRIVER }, actor);

    // No update/delete path was used at all — the originals are still exactly as ingested.
    expect(repo.events.map((event) => event.id)).toEqual(before);
    expect(repo.events.every((event) => event.recordStatus === 1 && event.recordOrigin === 4)).toBe(true);
    const markers = writer.rows.filter((row) => row.kind === 'INACTIVE_MARKER');
    expect(markers.map((row) => row.supersedesId)).toEqual([1n, 2n]);
  });

  it('closes the assigned segment with an off-duty record when the driver has nothing later', async () => {
    const { service, writer } = build();
    await service.assign('seg-1', { driverId: DRIVER }, actor);
    const restore = writer.rows.find((row) => row.kind === 'RESTORE');
    expect(restore).toMatchObject({ eventType: 1, eventCode: 1, at: new Date('2026-06-01T13:00:00Z') });
  });

  it('writes UNIDENTIFIED_ASSIGNED to the audit log and queues a recalculation', async () => {
    const { service, audit, hosQueue } = build();
    await service.assign('seg-1', { driverId: DRIVER }, actor);
    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UNIDENTIFIED_ASSIGNED', objectType: 'UnidentifiedSegment' }),
    );
    expect(hosQueue.add).toHaveBeenCalledWith('hos.recalc', expect.objectContaining({ driverId: DRIVER }));
  });

  it('B-059: rebuilds the driver day headers over the segment span after the records are written', async () => {
    const { service, writer, repo, logs } = build();
    await service.assign('seg-1', { driverId: DRIVER }, actor);
    // B-050 — the rebuild is now part of `LogsService.recordLogChange` (void + rebuild + publish).
    expect(logs.recordLogChange).toHaveBeenCalledWith(
      DRIVER,
      'America/New_York',
      new Date('2026-06-01T12:00:00Z'),
      new Date('2026-06-01T13:00:00Z'),
    );
    // After both appends and after the segment left PENDING, so hasUnassigned is rebuilt correctly.
    const rebuildOrder = logs.recordLogChange.mock.invocationCallOrder[0];
    expect(rebuildOrder).toBeGreaterThan(writer.append.mock.invocationCallOrder[1]);
    expect(rebuildOrder).toBeGreaterThan(repo.updateSegment.mock.invocationCallOrder[0]);
  });

  // bugs.md B-050 — the attributed driving changes a (possibly certified) RODS day: §395.8(f)/§9.2
  // require re-certification, through the same hook an accepted edit uses (`LogsService`).
  it('B-050: voids the certification of every day the assigned segment touches', async () => {
    const { service, writer, repo, logs, events } = build();
    await service.assign('seg-1', { driverId: DRIVER }, actor);
    expect(logs.recordLogChange).toHaveBeenCalledWith(
      DRIVER,
      'America/New_York',
      new Date('2026-06-01T12:00:00Z'),
      new Date('2026-06-01T13:00:00Z'),
    );
    const order = logs.recordLogChange.mock.invocationCallOrder[0];
    expect(order).toBeGreaterThan(writer.append.mock.invocationCallOrder[1]);
    expect(order).toBeGreaterThan(repo.updateSegment.mock.invocationCallOrder[0]);
    expect(events.publish).toHaveBeenCalledWith('unidentified.assigned', expect.objectContaining({ driverId: DRIVER }));
  });

  it('B-059: a refused assignment rebuilds nothing', async () => {
    const { service, repo, logs } = build();
    repo.segment = { ...repo.segment, status: 'ASSIGNED', assignedDriverId: DRIVER };
    await expect(service.assign('seg-1', { driverId: DRIVER }, actor)).rejects.toMatchObject({ status: 409 });
    expect(logs.recordLogChange).not.toHaveBeenCalled();
  });

  it('refuses to assign a segment twice', async () => {
    const { service, repo } = build();
    repo.segment = { ...repo.segment, status: 'ASSIGNED', assignedDriverId: DRIVER };
    await expect(service.assign('seg-1', { driverId: DRIVER }, actor)).rejects.toMatchObject({
      code: 'UNIDENTIFIED_ALREADY_ASSIGNED',
      status: 409,
    });
  });

  it('404s for an unknown driver', async () => {
    const { service, repo } = build();
    repo.driver = null;
    await expect(service.assign('seg-1', { driverId: 'nope' }, actor)).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
    });
  });
});

describe('rejection', () => {
  it('returns the records to the pool with recordOrigin 4 and driverId null', async () => {
    const { service, repo, writer } = build();
    repo.segment = { ...repo.segment, status: 'ASSIGNED', assignedDriverId: DRIVER };
    repo.events = [
      ...repo.events,
      { ...poolEvent(11n, '2026-06-01T12:00:00Z'), driverId: DRIVER, recordOrigin: 1, supersedesId: 1n },
      { ...poolEvent(12n, '2026-06-01T13:00:00Z', 1), driverId: DRIVER, recordOrigin: 1, supersedesId: 2n },
    ];

    const view = await service.reject('seg-1', { reason: 'Not this driver' }, actor);

    expect(view).toMatchObject({ status: 'REJECTED', assignedDriverId: null });
    const poolCall = writer.calls.find((call) => call.ctx.driverId === null);
    expect(poolCall).toBeDefined();
    for (const row of poolCall!.rows) {
      expect(row.recordOrigin).toBe(4);
      expect(row.recordStatus).toBe(1);
    }
    expect(poolCall!.ctx.sequenceKey).toBe('unidentified:veh-1');
  });

  it('B-059: rebuilds the previously assigned driver day headers over the segment span', async () => {
    const { service, repo, logs } = build();
    repo.segment = { ...repo.segment, status: 'ASSIGNED', assignedDriverId: DRIVER };
    await service.reject('seg-1', { reason: 'Not this driver' }, actor);
    expect(logs.recordLogChange).toHaveBeenCalledWith(
      DRIVER,
      'America/New_York',
      new Date('2026-06-01T12:00:00Z'),
      new Date('2026-06-01T13:00:00Z'),
    );
  });

  it('B-050: voids the certification of every day the rejected segment touched', async () => {
    const { service, repo, logs } = build();
    repo.segment = { ...repo.segment, status: 'ASSIGNED', assignedDriverId: DRIVER };
    await service.reject('seg-1', { reason: 'Not this driver' }, actor);
    expect(logs.recordLogChange).toHaveBeenCalledWith(
      DRIVER,
      'America/New_York',
      new Date('2026-06-01T12:00:00Z'),
      new Date('2026-06-01T13:00:00Z'),
    );
  });

  it('just marks an unassigned segment rejected', async () => {
    const { service, writer, audit, logs } = build();
    const view = await service.reject('seg-1', {}, actor);
    expect(view.status).toBe('REJECTED');
    expect(logs.recordLogChange).not.toHaveBeenCalled();
    expect(writer.rows).toHaveLength(0);
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'UNIDENTIFIED_REJECTED' }));
  });
});

describe('annotation and driver confirmation', () => {
  it('annotates a pending segment and audits it', async () => {
    const { service, audit } = build();
    const view = await service.annotate('seg-1', { annotation: 'Yard shunt by mechanic' }, actor);
    expect(view).toMatchObject({ status: 'ANNOTATED', annotation: 'Yard shunt by mechanic' });
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'UNIDENTIFIED_ANNOTATED' }));
  });

  it('a driver accepting "was this you?" assigns the segment to themselves, origin still 1', async () => {
    const { service, writer } = build();
    await service.confirm('seg-1', { accept: true }, { id: DRIVER, type: 'driver' });
    const copies = writer.rows.filter((row) => row.kind === 'NEW_ACTIVE');
    expect(copies.every((row) => row.recordOrigin === 1)).toBe(true);
  });

  it('a driver declining leaves the segment unidentified', async () => {
    const { service, writer, audit } = build();
    const view = await service.confirm('seg-1', { accept: false }, { id: DRIVER, type: 'driver' });
    expect(view.status).toBe('PENDING');
    expect(writer.rows).toHaveLength(0);
    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UNIDENTIFIED_CONFIRM_DECLINED' }),
    );
  });

  it('refuses a self-claim for a unit the driver never operated (§395.32 IDOR regression)', async () => {
    const { service, repo, writer, audit } = build();
    repo.associated = false;

    await expect(
      service.confirm('seg-1', { accept: true }, { id: 'driver-2', type: 'driver' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Nothing was attributed: another driver's unidentified driving stays in the pool.
    expect(writer.rows).toHaveLength(0);
    expect(repo.updateSegment).not.toHaveBeenCalled();
    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UNIDENTIFIED_CONFIRM_DENIED' }),
    );
  });

  it('checks the association against the segment vehicle and end time, not client input', async () => {
    const { service, repo } = build();
    await service.confirm('seg-1', { accept: true }, { id: DRIVER, type: 'driver' });
    expect(repo.hasDriverVehicleAssociation).toHaveBeenCalledWith(
      DRIVER,
      'veh-1',
      new Date('2026-06-01T13:00:00Z'),
    );
  });
});

describe('B-83 — assignment that waits for the driver to confirm (§395.32)', () => {
  const driverActor = { id: DRIVER, type: 'driver' as const };

  async function requested() {
    const ctx = build();
    await ctx.service.assign('seg-1', { driverId: DRIVER, requireDriverConfirmation: true }, actor);
    return ctx;
  }

  it('attributes NOTHING: no record is written, the driver log is untouched, the segment is PENDING_CONFIRMATION', async () => {
    const { repo, writer, logs, hosQueue } = await requested();
    expect(writer.calls).toHaveLength(0);
    expect(logs.recordLogChange).not.toHaveBeenCalled();
    expect(hosQueue.add).not.toHaveBeenCalled();
    expect(repo.segment).toMatchObject({
      status: 'PENDING_CONFIRMATION',
      assignedDriverId: DRIVER,
      assignedById: 'user-1',
      assignedAt: null,
    });
    expect(repo.segment.confirmationRequestedAt).toBeInstanceOf(Date);
  });

  it('audits the request and pushes it to the driver app (socket + alert pipeline)', async () => {
    const { audit, events, alertQueue } = await requested();
    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UNIDENTIFIED_CONFIRMATION_REQUESTED', objectId: 'seg-1' }),
    );
    expect(events.publish).toHaveBeenCalledWith(
      'realtime.push',
      expect.objectContaining({ room: `driver:${DRIVER}`, event: 'unidentified.confirmation_requested' }),
    );
    expect(alertQueue.add).toHaveBeenCalledWith(
      'alert.unidentified_confirmation_requested',
      expect.objectContaining({ segmentId: 'seg-1', driverId: DRIVER }),
    );
  });

  it('the asked driver confirming attributes the records with origin 1, keeping the carrier as assignedById', async () => {
    const ctx = await requested();
    ctx.repo.hasDriverVehicleAssociation.mockClear();
    const view = await ctx.service.confirm('seg-1', { accept: true }, driverActor);
    expect(view.status).toBe('ASSIGNED');
    expect(ctx.repo.segment).toMatchObject({ assignedDriverId: DRIVER, assignedById: 'user-1' });
    const attributed = ctx.writer.calls.find((call) => call.ctx.driverId === DRIVER);
    expect(attributed?.rows.filter((row) => row.kind === 'NEW_ACTIVE').every((row) => row.recordOrigin === 1)).toBe(true);
    expect(ctx.writer.rows.some((row) => row.recordOrigin === 2)).toBe(false);
    expect(ctx.logs.recordLogChange).toHaveBeenCalled();
    expect(ctx.audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UNIDENTIFIED_ASSIGNED',
        after: expect.objectContaining({ confirmedByDriver: true, assignedById: 'user-1' }) as unknown,
      }),
    );
  });

  it('the asked driver declining returns the segment to PENDING and writes nothing', async () => {
    const ctx = await requested();
    const view = await ctx.service.confirm('seg-1', { accept: false }, driverActor);
    expect(view.status).toBe('PENDING');
    expect(ctx.repo.segment).toMatchObject({ assignedDriverId: null, confirmationRequestedAt: null });
    expect(ctx.writer.calls).toHaveLength(0);
    expect(ctx.audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UNIDENTIFIED_CONFIRMATION_DECLINED' }),
    );
  });

  it('another driver cannot answer a request addressed to someone else', async () => {
    const ctx = await requested();
    await expect(
      ctx.service.confirm('seg-1', { accept: true }, { id: 'driver-2', type: 'driver' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(ctx.writer.calls).toHaveLength(0);
  });

  it('a carrier rejection withdraws the pending request', async () => {
    const ctx = await requested();
    await ctx.service.reject('seg-1', {}, actor);
    expect(ctx.repo.segment).toMatchObject({ status: 'REJECTED', assignedDriverId: null, confirmationRequestedAt: null });
    expect(ctx.writer.calls).toHaveLength(0);
  });

  it('lists the requests addressed to the calling driver only', async () => {
    const { service, repo } = build();
    await service.listConfirmationRequests(driverActor);
    expect(repo.listSegments).toHaveBeenCalledWith(
      { status: 'PENDING_CONFIRMATION', assignedDriverId: DRIVER },
      1,
      200,
    );
  });

  it('without the flag the assignment is immediate, as before', async () => {
    const { service, repo, writer } = build();
    await service.assign('seg-1', { driverId: DRIVER, requireDriverConfirmation: false }, actor);
    expect(repo.segment.status).toBe('ASSIGNED');
    expect(writer.calls.length).toBeGreaterThan(0);
  });
});
