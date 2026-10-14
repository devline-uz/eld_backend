/**
 * TZ §5.9 / §7.4 / §23 — unidentified driving.
 *   CODE-029 — a carrier assignment only asks the driver; the records are attributed when the
 *   DRIVER accepts, as origin 4 (Appendix A 4.4.4.2.4(e), MB-3), and are NEVER origin 2;
 *   rejection puts the records back in the pool (origin 4, driverId null);
 *   device-stored records are never lost — nothing is updated or deleted, only appended.
 */
import type { AppendRow } from '../logs/edit-plan';
import type { RodsEventWriter } from '../logs/rods-event-writer';
import type { AuditRepository } from '../audit/audit.repository';
import type { EventBusService } from '../../core/events/event-bus.service';
import type { LogsService } from '../logs/logs.service';
import { buildRodsDay, type RodsEvent } from '../logs/rods';
import { AssignUnidentifiedDto } from './dto/unidentified.dto';
import { UnidentifiedService } from './unidentified.service';
import type { UnidentifiedRepository } from './unidentified.repository';

const DRIVER = 'driver-1';
const DRIVER_UUID = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

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
  findVehicleUnitNumbers = jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, `unit-${id}`])));
  findSupersedingEvents = jest.fn(async (ids: bigint[]) =>
    this.events.filter((e) => e.supersedesId !== null && ids.includes(e.supersedesId)),
  );
  /** CODE-007 — the driver's own records (every status) in the window, as the repository reads them. */
  findDriverEvents = jest.fn(async (driverId: string, from: Date, to: Date) =>
    this.events
      .filter((e) => e.driverId === driverId && e.eventDateTime >= from && e.eventDateTime <= to)
      .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime() || a.eventSequenceId - b.eventSequenceId),
  );
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

/**
 * CODE-029 — the only way records are attributed after a carrier assignment: the carrier
 * proposes (PENDING_CONFIRMATION) and the asked driver accepts in the app.
 */
async function assignAndConfirm(service: UnidentifiedService) {
  await service.assign('seg-1', { driverId: DRIVER }, actor);
  return service.confirm('seg-1', { accept: true }, { id: DRIVER, type: 'driver' as const });
}

describe('assignment', () => {
  it('CODE-029: the driver-confirmed copies are origin 4 (driver assumed them) and NEVER origin 2', async () => {
    const { service, writer } = build();

    await assignAndConfirm(service);

    const attributed = writer.calls.find((call) => call.ctx.driverId === DRIVER);
    expect(attributed).toBeDefined();
    const copies = attributed!.rows.filter((row) => row.kind === 'NEW_ACTIVE');
    expect(copies).toHaveLength(2);
    for (const row of copies) {
      expect(row.recordOrigin).toBe(4);
      expect(row.recordStatus).toBe(1);
    }
    // The §23 invariant, stated as bluntly as the checklist does.
    expect(writer.rows.every((row) => row.recordOrigin !== 2)).toBe(true);
  });

  it('sets status, assignedById and assignedAt on the segment', async () => {
    const { service, repo } = build();
    const view = await assignAndConfirm(service);
    expect(view).toMatchObject({ status: 'ASSIGNED', assignedDriverId: DRIVER, assignedById: 'user-1' });
    expect(repo.updateSegment).toHaveBeenCalledWith(
      'seg-1',
      expect.objectContaining({ status: 'ASSIGNED', assignedById: 'user-1' }),
    );
  });

  it('never loses the device-stored records: they are retired by an appended marker, not deleted', async () => {
    const { service, repo, writer } = build();
    const before = repo.events.map((event) => event.id);

    await assignAndConfirm(service);

    // No update/delete path was used at all — the originals are still exactly as ingested.
    expect(repo.events.map((event) => event.id)).toEqual(before);
    expect(repo.events.every((event) => event.recordStatus === 1 && event.recordOrigin === 4)).toBe(true);
    const markers = writer.rows.filter((row) => row.kind === 'INACTIVE_MARKER');
    expect(markers.map((row) => row.supersedesId)).toEqual([1n, 2n]);
  });

  it('closes the assigned segment with an off-duty record when the driver has nothing later', async () => {
    const { service, writer } = build();
    await assignAndConfirm(service);
    const restore = writer.rows.find((row) => row.kind === 'RESTORE');
    expect(restore).toMatchObject({ eventType: 1, eventCode: 1, at: new Date('2026-06-01T13:00:00Z') });
  });

  it('writes UNIDENTIFIED_ASSIGNED to the audit log and queues a recalculation', async () => {
    const { service, audit, hosQueue } = build();
    await assignAndConfirm(service);
    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UNIDENTIFIED_ASSIGNED', objectType: 'UnidentifiedSegment' }),
    );
    expect(hosQueue.add).toHaveBeenCalledWith('hos.recalc', expect.objectContaining({ driverId: DRIVER }));
  });

  it('B-059: rebuilds the driver day headers over the segment span after the records are written', async () => {
    const { service, writer, repo, logs } = build();
    await assignAndConfirm(service);
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
    expect(rebuildOrder).toBeGreaterThan(repo.updateSegment.mock.invocationCallOrder.at(-1)!);
  });

  // bugs.md B-050 — the attributed driving changes a (possibly certified) RODS day: §395.8(f)/§9.2
  // require re-certification, through the same hook an accepted edit uses (`LogsService`).
  it('B-050: voids the certification of every day the assigned segment touches', async () => {
    const { service, writer, repo, logs, events } = build();
    await assignAndConfirm(service);
    expect(logs.recordLogChange).toHaveBeenCalledWith(
      DRIVER,
      'America/New_York',
      new Date('2026-06-01T12:00:00Z'),
      new Date('2026-06-01T13:00:00Z'),
    );
    const order = logs.recordLogChange.mock.invocationCallOrder[0];
    expect(order).toBeGreaterThan(writer.append.mock.invocationCallOrder[1]);
    expect(order).toBeGreaterThan(repo.updateSegment.mock.invocationCallOrder.at(-1)!);
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

  it('MB-3: a driver self-claiming "was this you?" assumes the records with origin 4, never 2 (Appendix A 4.4.4.2.4(e))', async () => {
    const { service, writer, audit } = build();
    await service.confirm('seg-1', { accept: true }, { id: DRIVER, type: 'driver' });
    const copies = writer.rows.filter((row) => row.kind === 'NEW_ACTIVE');
    expect(copies.length).toBe(2);
    expect(copies.every((row) => row.recordOrigin === 4 && row.recordStatus === 1)).toBe(true);
    // 4.4.4.2.4(c) — the unidentified originals become Inactive — Changed.
    expect(writer.rows.filter((row) => row.kind === 'INACTIVE_MARKER').every((row) => row.recordStatus === 2)).toBe(true);
    expect(writer.rows.some((row) => row.recordOrigin === 2)).toBe(false);
    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UNIDENTIFIED_ASSIGNED',
        after: expect.objectContaining({ recordOrigin: 4, confirmedByDriver: true }) as unknown,
      }),
    );
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

  it('MB-3: the asked driver confirming assumes the records with origin 4, keeping the carrier as assignedById', async () => {
    const ctx = await requested();
    ctx.repo.hasDriverVehicleAssociation.mockClear();
    const view = await ctx.service.confirm('seg-1', { accept: true }, driverActor);
    expect(view.status).toBe('ASSIGNED');
    expect(ctx.repo.segment).toMatchObject({ assignedDriverId: DRIVER, assignedById: 'user-1' });
    const attributed = ctx.writer.calls.find((call) => call.ctx.driverId === DRIVER);
    const copies = attributed?.rows.filter((row) => row.kind === 'NEW_ACTIVE') ?? [];
    expect(copies.length).toBe(2);
    expect(copies.every((row) => row.recordOrigin === 4)).toBe(true);
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

  it('MB-3: rejecting a driver-assumed segment retires the origin-4 copies and returns them to the pool', async () => {
    const { service, repo, writer } = build();
    repo.segment = { ...repo.segment, status: 'ASSIGNED', assignedDriverId: DRIVER };
    repo.events = [
      ...repo.events,
      { ...poolEvent(11n, '2026-06-01T12:00:00Z'), driverId: DRIVER, recordOrigin: 4, supersedesId: 1n },
      { ...poolEvent(12n, '2026-06-01T13:00:00Z', 1), driverId: DRIVER, recordOrigin: 4, supersedesId: 2n },
    ];
    await service.reject('seg-1', { reason: 'Not this driver' }, actor);
    const driverCall = writer.calls.find((call) => call.ctx.driverId === DRIVER)!;
    expect(driverCall.rows.every((row) => row.recordStatus === 2 && row.recordOrigin === 4)).toBe(true);
    const poolCall = writer.calls.find((call) => call.ctx.driverId === null)!;
    expect(poolCall.rows.every((row) => row.recordStatus === 1 && row.recordOrigin === 4)).toBe(true);
  });

  it('MB-11: each confirmation request carries location text, unit number and odometer readings', async () => {
    const { service, repo } = build();
    repo.segment = { ...repo.segment, status: 'PENDING_CONFIRMATION', assignedDriverId: DRIVER, startLocation: null, endLocation: null };
    repo.events = [
      { ...poolEvent(1n, '2026-06-01T12:00:00Z'), locationName: 'Florence, KY', totalVehicleMiles: 1000 },
      { ...poolEvent(2n, '2026-06-01T13:00:00Z', 1), locationName: 'Walton, KY', totalVehicleMiles: 1042 },
    ];
    const { items } = await service.listConfirmationRequests(driverActor);
    expect(items[0]).toMatchObject({
      id: 'seg-1',
      status: 'PENDING_CONFIRMATION',
      startLocation: 'Florence, KY',
      endLocation: 'Walton, KY',
      unitNumber: 'unit-veh-1',
      startOdometerMi: 1000,
      endOdometerMi: 1042,
    });
  });

  it('MB-11: a stored segment location wins; missing odometers are null', async () => {
    const { service, repo } = build();
    repo.segment = { ...repo.segment, status: 'PENDING_CONFIRMATION', assignedDriverId: DRIVER, startLocation: '2mi E KY Florence', endLocation: null };
    repo.events = repo.events.map((event) => ({ ...event, totalVehicleMiles: null }));
    const { items } = await service.listConfirmationRequests(driverActor);
    expect(items[0]).toMatchObject({ startLocation: '2mi E KY Florence', endLocation: 'Florence, KY', startOdometerMi: null, endOdometerMi: null });
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

  it('CODE-029: without the flag a carrier assignment still only asks the driver', async () => {
    const { service, repo, writer } = build();
    await service.assign('seg-1', { driverId: DRIVER }, actor);
    expect(repo.segment.status).toBe('PENDING_CONFIRMATION');
    expect(writer.calls).toHaveLength(0);
  });

  it('CODE-029: requireDriverConfirmation = false is refused by the DTO', () => {
    expect(AssignUnidentifiedDto.safeParse({ driverId: DRIVER_UUID, requireDriverConfirmation: false }).success).toBe(false);
    expect(AssignUnidentifiedDto.safeParse({ driverId: DRIVER_UUID, requireDriverConfirmation: true }).success).toBe(true);
    expect(AssignUnidentifiedDto.safeParse({ driverId: DRIVER_UUID }).success).toBe(true);
  });
});

/**
 * CODE-007 — assigning unidentified driving must add exactly the segment to the driver's log:
 * the segment's last status may not run on until the driver's next own record, and a segment
 * that overlaps the driver's own records is refused.
 */
describe('CODE-007 — the segment ends where it ends and never overlaps the driver log', () => {
  const at = (hhmm: string, day = '2026-06-01') => new Date(`${day}T${hhmm}:00Z`);

  function ownEvent(id: bigint, when: Date, code: number, extra: Partial<FakeEvent> = {}): FakeEvent {
    return { ...poolEvent(id, when.toISOString(), code), driverId: DRIVER, recordOrigin: 1, wasStoredOnDevice: false, ...extra };
  }

  /** Repro (agentB/unid.ts): driver OFF 09:00 -> ON next day 06:00; pool D@10:00, ON@12:00, segment to 12:30. */
  function repro(poolCodes: Array<[string, number]>, endAt: Date) {
    const ctx = build();
    ctx.repo.driver = { id: DRIVER, username: 'jsmith', homeTerminalTimezone: 'UTC' };
    const pool = poolCodes.map(([hhmm, code], i) => poolEvent(BigInt(100 + i), at(hhmm).toISOString(), code));
    ctx.repo.segment = { ...ctx.repo.segment, startAt: pool[0].eventDateTime, endAt, eventIds: pool.map((e) => e.id) };
    ctx.repo.events = [...pool, ownEvent(10n, at('09:00'), 1), ownEvent(11n, at('06:00', '2026-06-02'), 4)];
    return ctx;
  }

  /** The driver's RODS day after the assignment: own records + everything appended for the driver. */
  function dayAfter(ctx: ReturnType<typeof build>): ReturnType<typeof buildRodsDay> {
    let id = 1000n;
    let seq = 1000;
    const own = ctx.repo.events.filter((e) => e.driverId === DRIVER) as unknown as RodsEvent[];
    const appended = ctx.writer.calls
      .filter((call) => call.ctx.driverId === DRIVER)
      .flatMap((call) => call.rows)
      .map((row) => ({
        id: id++,
        eventType: row.eventType,
        eventCode: row.eventCode,
        eventDateTime: row.at,
        recordStatus: row.recordStatus,
        recordOrigin: row.recordOrigin,
        eventSequenceId: seq++,
        supersedesId: row.supersedesId,
      }));
    return buildRodsDay([...own, ...appended], 'UTC', '2026-06-01', at('12:00', '2026-06-03'));
  }

  const hours = (sec: number) => sec / 3600;

  it('repro: a fully off-duty day gets exactly D 2 h + ON 0.5 h — not D 2 h + ON 12 h', async () => {
    const ctx = repro([['10:00', 3], ['12:00', 4]], at('12:30'));
    await assignAndConfirm(ctx.service);

    const restore = ctx.writer.rows.find((row) => row.kind === 'RESTORE');
    expect(restore).toMatchObject({ eventType: 1, eventCode: 1, at: at('12:30'), recordStatus: 1, recordOrigin: 3 });
    const day = dayAfter(ctx);
    expect(hours(day.drivingSec)).toBe(2);
    expect(hours(day.onDutySec)).toBe(0.5);
    expect(hours(day.offDutySec)).toBe(21.5);
  });

  it('repro: a pool ending on DRIVING adds only its own driving (D 2 h, not 14 h)', async () => {
    const ctx = repro([['10:00', 3]], at('12:00'));
    await assignAndConfirm(ctx.service);
    const day = dayAfter(ctx);
    expect(hours(day.drivingSec)).toBe(2);
    expect(hours(day.onDutySec)).toBe(0);
    expect(hours(day.offDutySec)).toBe(22);
  });

  it("restores the driver's OWN prior status at the segment end (ON stays ON, not OFF)", async () => {
    const ctx = repro([['10:00', 3]], at('12:00'));
    ctx.repo.events.push(ownEvent(12n, at('09:30'), 4));
    await assignAndConfirm(ctx.service);
    expect(ctx.writer.rows.find((row) => row.kind === 'RESTORE')).toMatchObject({ eventCode: 4, at: at('12:00') });
  });

  it('writes no RESTORE when the driver has an own duty-status record exactly at the segment end', async () => {
    const ctx = repro([['10:00', 3]], at('12:00'));
    ctx.repo.events.push(ownEvent(12n, at('12:00'), 4));
    await assignAndConfirm(ctx.service);
    expect(ctx.writer.rows.some((row) => row.kind === 'RESTORE')).toBe(false);
  });

  it('refuses a segment that overlaps the driver\'s own records (409), writing nothing', async () => {
    const ctx = repro([['10:00', 3]], at('12:00'));
    ctx.repo.events.push(ownEvent(12n, at('11:00'), 4));
    await expect(ctx.service.assign('seg-1', { driverId: DRIVER }, actor)).rejects.toMatchObject({
      code: 'UNIDENTIFIED_OVERLAPS_DRIVER_LOG',
      status: 409,
      details: expect.objectContaining({ reason: 'OWN_RECORDS_INSIDE', conflictingAt: [at('11:00').toISOString()] }) as unknown,
    });
    expect(ctx.writer.append).not.toHaveBeenCalled();
    expect(ctx.repo.updateSegment).not.toHaveBeenCalled();
    expect(ctx.hosQueue.add).not.toHaveBeenCalled();
  });

  it('refuses a segment that starts while the driver was already DRIVING', async () => {
    const ctx = repro([['10:00', 3]], at('12:00'));
    ctx.repo.events.push(ownEvent(12n, at('09:30'), 3));
    await expect(ctx.service.assign('seg-1', { driverId: DRIVER }, actor)).rejects.toMatchObject({
      code: 'UNIDENTIFIED_OVERLAPS_DRIVER_LOG',
      details: expect.objectContaining({ reason: 'DRIVING_AT_START' }) as unknown,
    });
    expect(ctx.writer.append).not.toHaveBeenCalled();
  });

  it('a record the driver already retired by an accepted edit is not an overlap (same timeline as the log)', async () => {
    const ctx = repro([['10:00', 3]], at('12:00'));
    ctx.repo.events.push(
      ownEvent(12n, at('11:00'), 4),
      ownEvent(13n, at('11:00'), 4, { recordStatus: 2, recordOrigin: 3, supersedesId: 12n }),
    );
    await assignAndConfirm(ctx.service);
    expect(ctx.repo.segment.status).toBe('ASSIGNED');
  });

  it('B-83: an overlapping segment is refused before the driver is even asked', async () => {
    const ctx = repro([['10:00', 3]], at('12:00'));
    ctx.repo.events.push(ownEvent(12n, at('11:00'), 4));
    await expect(
      ctx.service.assign('seg-1', { driverId: DRIVER, requireDriverConfirmation: true }, actor),
    ).rejects.toMatchObject({ code: 'UNIDENTIFIED_OVERLAPS_DRIVER_LOG' });
    expect(ctx.repo.updateSegment).not.toHaveBeenCalled();
    expect(ctx.events.publish).not.toHaveBeenCalled();
  });
});
