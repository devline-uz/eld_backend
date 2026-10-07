import { TripsService } from './trips.service';

function buildService(trip: Record<string, unknown> | null = { id: 'trp_1', status: 'PLANNED', driverId: null, etaAt: null }) {
  const repo = {
    findByNumber: jest.fn(async () => null),
    findById: jest.fn(async () => trip),
    createWithStops: jest.fn(async (data: unknown) => ({ id: 'trp_new', ...(data as object) })),
    update: jest.fn(async (_where: unknown, data: unknown) => ({ ...trip, ...(data as object) })),
    unassignedLoads: jest.fn(async () => []),
    availableDriverIds: jest.fn(async () => []),
    list: jest.fn(async () => ({ items: [], total: 0 })),
    findTrailer: jest.fn(async (id: string): Promise<{ id: string; deletedAt: Date | null } | null> => ({ id, deletedAt: null })),
    findUnitScheduleCandidates: jest.fn(async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => []),
    withUnitScheduleLock: jest.fn(async (_vehicleId: string, work: (db: unknown) => Promise<unknown>) => work('tx')),
  };
  const events = { publish: jest.fn(async () => undefined) };
  const alertQueue = { add: jest.fn(async () => undefined) };
  return { service: new TripsService(repo as never, events as never, alertQueue as never), repo, events, alertQueue };
}

describe('TripsService — duplicate trip number', () => {
  const message = 'A trip with this number already exists.';

  it('create rejects an existing number with 409 CONFLICT keyed details.number (field-level on the web)', async () => {
    const { service, repo } = buildService();
    repo.findByNumber.mockResolvedValueOnce({ id: 'trp_old', number: 'TRP-1' } as never);
    await expect(service.create({ number: 'TRP-1', draft: false }, 'usr_1')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message,
      details: { number: message },
    });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('maps a P2002 on Trip.number that races the pre-check to the same 409', async () => {
    const { service, repo } = buildService();
    repo.createWithStops.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['number'] } }));
    await expect(service.create({ number: 'TRP-1', draft: false }, 'usr_1')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { number: message },
    });
  });

  it('leaves any other write error untouched', async () => {
    const { service, repo } = buildService();
    const boom = Object.assign(new Error('fk'), { code: 'P2003' });
    repo.createWithStops.mockRejectedValueOnce(boom);
    await expect(service.create({ number: 'TRP-1', draft: false }, 'usr_1')).rejects.toBe(boom);
  });
});

describe('TripsService — lifecycle transitions', () => {
  it('allows PLANNED -> ASSIGNED', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    const result = await service.update('trp_1', { status: 'ASSIGNED' });
    expect(result.status).toBe('ASSIGNED');
  });

  it('rejects PLANNED -> DELIVERED (must pass through ASSIGNED/IN_PROGRESS)', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    await expect(service.update('trp_1', { status: 'DELIVERED' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects any transition out of a terminal DELIVERED trip', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'DELIVERED', etaAt: null });
    await expect(service.update('trp_1', { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('sets startedAt on the transition into IN_PROGRESS', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'ASSIGNED', etaAt: null, startedAt: null });
    await service.update('trp_1', { status: 'IN_PROGRESS' });
    const data = repo.update.mock.calls[0][1] as { startedAt?: Date };
    expect(data.startedAt).toBeInstanceOf(Date);
  });

  it('publishes trip.status_changed only when the status actually changes', async () => {
    const { service, events } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    await service.update('trp_1', { notes: 'no status change' });
    expect(events.publish).not.toHaveBeenCalled();
  });
});

describe('TripsService — assign', () => {
  it('rejects assigning a trip that is already IN_PROGRESS', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'IN_PROGRESS', etaAt: null });
    await expect(service.assign('trp_1', { driverId: 'drv_1', notify: true })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('assigns a PLANNED trip and raises alert.trip_assigned', async () => {
    const { service, alertQueue } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    const result = await service.assign('trp_1', { driverId: 'drv_1', notify: true });
    expect(result.status).toBe('ASSIGNED');
    expect(alertQueue.add).toHaveBeenCalledWith('alert.trip_assigned', { tripId: 'trp_1', driverId: 'drv_1' });
  });

  it('§20 B-74 — notify: false assigns without raising the driver-app notification', async () => {
    const { service, alertQueue } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    const result = await service.assign('trp_1', { driverId: 'drv_1', notify: false });
    expect(result.status).toBe('ASSIGNED');
    expect(alertQueue.add).not.toHaveBeenCalled();
  });
});

describe('TripsService — create (§20 B-73 draft)', () => {
  it('creates a DRAFT trip when draft: true, even with a driverId', async () => {
    const { service, repo } = buildService();
    await service.create({ number: 'TRP-9', driverId: 'drv_1', draft: true }, 'usr_1');
    const data = repo.createWithStops.mock.calls[0][0] as Record<string, unknown>;
    expect(data.status).toBe('DRAFT');
  });

  it('creates a PLANNED trip by default (no driverId, draft: false)', async () => {
    const { service, repo } = buildService();
    await service.create({ number: 'TRP-10', draft: false }, 'usr_1');
    const data = repo.createWithStops.mock.calls[0][0] as Record<string, unknown>;
    expect(data.status).toBe('PLANNED');
  });
});

describe('TripsService — DRAFT lifecycle (§20 B-73 publish)', () => {
  it('publishes a DRAFT trip via PATCH { status: PLANNED }', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'DRAFT', etaAt: null });
    const result = await service.update('trp_1', { status: 'PLANNED' });
    expect(result.status).toBe('PLANNED');
  });

  it('rejects DRAFT -> ASSIGNED (must publish to PLANNED first)', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'DRAFT', etaAt: null });
    await expect(service.update('trp_1', { status: 'ASSIGNED' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('TripsService — trailer must be live (soft-deleted trailers)', () => {
  const TRL = '33333333-3333-4333-8333-333333333333';

  it('create stores a live trailerId', async () => {
    const { service, repo } = buildService();
    await service.create({ number: 'TRP-11', trailerId: TRL, draft: false }, 'usr_1');
    expect(repo.findTrailer).toHaveBeenCalledWith(TRL);
    expect((repo.createWithStops.mock.calls[0][0] as Record<string, unknown>).trailerId).toBe(TRL);
  });

  it('create rejects a soft-deleted trailerId with 422 TRAILER_NOT_FOUND and writes nothing', async () => {
    const { service, repo } = buildService();
    repo.findTrailer.mockResolvedValueOnce({ id: TRL, deletedAt: new Date('2026-10-01T00:00:00Z') });
    await expect(service.create({ number: 'TRP-12', trailerId: TRL, draft: false }, 'usr_1')).rejects.toMatchObject({
      code: 'TRAILER_NOT_FOUND',
      status: 422,
      details: { trailerId: 'This trailer has been deleted and cannot be assigned.' },
    });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('create rejects an unknown trailerId with 422 (Trip.trailerId has no FK)', async () => {
    const { service, repo } = buildService();
    repo.findTrailer.mockResolvedValueOnce(null);
    await expect(service.create({ number: 'TRP-13', trailerId: TRL, draft: false }, 'usr_1')).rejects.toMatchObject({ code: 'TRAILER_NOT_FOUND', status: 422 });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('assign rejects a soft-deleted trailerId', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null, trailerId: null });
    repo.findTrailer.mockResolvedValueOnce({ id: TRL, deletedAt: new Date() });
    await expect(service.assign('trp_1', { driverId: 'drv_1', trailerId: TRL, notify: false })).rejects.toMatchObject({ code: 'TRAILER_NOT_FOUND', status: 422 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("assign re-sending the trip's current (since-deleted) trailer is not re-validated", async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'ASSIGNED', etaAt: null, trailerId: TRL });
    await service.assign('trp_1', { driverId: 'drv_2', trailerId: TRL, notify: false });
    expect(repo.findTrailer).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalled();
  });
});

describe('TripsService — unit schedule overlap (web panel)', () => {
  const VEH = '44444444-4444-4444-8444-444444444444';
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h));
  const other = (o: Record<string, unknown> = {}) => ({
    id: 'trp_other',
    number: 'TRP-500',
    status: 'ASSIGNED',
    plannedStartAt: at(10),
    plannedEndAt: at(14),
    startedAt: null,
    completedAt: null,
    vehicle: { unitNumber: '101' },
    ...o,
  });

  it('create rejects an overlapping trip on the same unit with 409 TRIP_SCHEDULE_CONFLICT naming the other trip', async () => {
    const { service, repo } = buildService();
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(
      service.create({ number: 'TRP-1', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({
      code: 'TRIP_SCHEDULE_CONFLICT',
      status: 409,
      message: 'Unit 101 is already assigned to another trip (TRP-500) from 2026-10-10 10:00 UTC to 2026-10-10 14:00 UTC.',
      details: {
        vehicleId: 'Unit 101 is already assigned to another trip (TRP-500) from 2026-10-10 10:00 UTC to 2026-10-10 14:00 UTC.',
        conflict: { tripId: 'trp_other', number: 'TRP-500', start: at(10).toISOString(), end: at(14).toISOString() },
      },
    });
    expect(repo.withUnitScheduleLock).toHaveBeenCalledWith(VEH, expect.any(Function));
    expect(repo.findUnitScheduleCandidates).toHaveBeenCalledWith(VEH, { start: at(12), end: at(16) }, undefined, 'tx');
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('create allows a trip that starts exactly when the other one ends (touching endpoints)', async () => {
    const { service, repo } = buildService();
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other()]);
    await service.create({ number: 'TRP-2', vehicleId: VEH, plannedStartAt: at(14), plannedEndAt: at(18), draft: false }, 'usr_1');
    expect(repo.createWithStops).toHaveBeenCalledWith(expect.anything(), [], 'tx');
  });

  it('create allows the same range on a different unit (only that unit is queried)', async () => {
    const { service, repo } = buildService();
    const OTHER_VEH = '55555555-5555-4555-8555-555555555555';
    await service.create({ number: 'TRP-3', vehicleId: OTHER_VEH, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1');
    expect(repo.findUnitScheduleCandidates.mock.calls[0][0]).toBe(OTHER_VEH);
    expect(repo.createWithStops).toHaveBeenCalled();
  });

  it('create ignores a CANCELLED trip in the same range', async () => {
    const { service, repo } = buildService();
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other({ status: 'CANCELLED' })]);
    await service.create({ number: 'TRP-4', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1');
    expect(repo.createWithStops).toHaveBeenCalled();
  });

  it('create rejects a trip after an open-ended (no planned end) trip on the same unit', async () => {
    const { service, repo } = buildService();
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other({ plannedEndAt: null })]);
    await expect(
      service.create({ number: 'TRP-5', vehicleId: VEH, plannedStartAt: at(30), plannedEndAt: at(34), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT', message: 'Unit 101 is already assigned to another trip (TRP-500) from 2026-10-10 10:00 UTC onward (no planned end).' });
  });

  it('create without a planned end occupies the unit open-ended, so a later trip blocks it', async () => {
    const { service, repo } = buildService();
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other({ plannedStartAt: at(40), plannedEndAt: at(44) })]);
    await expect(
      service.create({ number: 'TRP-6', vehicleId: VEH, plannedStartAt: at(12), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
  });

  it('a DELIVERED trip blocks only its actual range', async () => {
    const { service, repo } = buildService();
    // planned 10–14 but actually driven 10–12: 12–16 is free.
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other({ status: 'DELIVERED', startedAt: at(10), completedAt: at(12) })]);
    await service.create({ number: 'TRP-7', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1');
    expect(repo.createWithStops).toHaveBeenCalled();
  });

  it('a draft with a unit is checked too (it reserves the unit on the Scheduled board)', async () => {
    const { service, repo } = buildService();
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(
      service.create({ number: 'TRP-8', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), draft: true }, 'usr_1'),
    ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('an existing DRAFT on the unit blocks a new trip in its range', async () => {
    const { service, repo } = buildService();
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other({ status: 'DRAFT' })]);
    await expect(
      service.create({ number: 'TRP-8b', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
  });

  it('a draft without a unit or without a start is never checked', async () => {
    const { service, repo } = buildService();
    await service.create({ number: 'TRP-8c', plannedStartAt: at(12), draft: true }, 'usr_1');
    await service.create({ number: 'TRP-8d', vehicleId: VEH, draft: true }, 'usr_1');
    expect(repo.findUnitScheduleCandidates).not.toHaveBeenCalled();
    expect(repo.createWithStops).toHaveBeenCalledTimes(2);
  });

  it('create rejects plannedEndAt not after plannedStartAt with 422 on plannedEndAt', async () => {
    const { service, repo } = buildService();
    await expect(
      service.create({ number: 'TRP-9', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(12), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, details: { plannedEndAt: 'Planned end must be after planned start.' } });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('update re-checks a moved range, excluding the trip itself', async () => {
    const self = { id: 'trp_1', status: 'ASSIGNED', vehicleId: VEH, plannedStartAt: at(10), plannedEndAt: at(14), etaAt: null };
    const { service, repo } = buildService(self);
    // The query already excludes the trip; even if it came back, the service skips it.
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other({ id: 'trp_1', number: 'TRP-1' })]);
    await service.update('trp_1', { plannedEndAt: at(16) });
    expect(repo.findUnitScheduleCandidates).toHaveBeenCalledWith(VEH, { start: at(10), end: at(16) }, 'trp_1', 'tx');
    expect(repo.update).toHaveBeenCalledWith({ id: 'trp_1' }, expect.anything(), 'tx');
  });

  it('update rejects a moved range that overlaps another trip on the unit', async () => {
    const self = { id: 'trp_1', status: 'PLANNED', vehicleId: VEH, plannedStartAt: at(0), plannedEndAt: at(4), etaAt: null };
    const { service, repo } = buildService(self);
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(service.update('trp_1', { plannedStartAt: at(9), plannedEndAt: at(11) })).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT', status: 409 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('update validates the merged range (new end before the stored start)', async () => {
    const self = { id: 'trp_1', status: 'PLANNED', vehicleId: VEH, plannedStartAt: at(10), plannedEndAt: at(14), etaAt: null };
    const { service } = buildService(self);
    await expect(service.update('trp_1', { plannedEndAt: at(9) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('publishing a DRAFT checks the unit', async () => {
    const self = { id: 'trp_1', status: 'DRAFT', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null };
    const { service, repo } = buildService(self);
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(service.update('trp_1', { status: 'PLANNED' })).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
  });

  it('a plain field edit (no time change) does not run the check', async () => {
    const self = { id: 'trp_1', status: 'ASSIGNED', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null };
    const { service, repo } = buildService(self);
    await service.update('trp_1', { notes: 'x' });
    expect(repo.findUnitScheduleCandidates).not.toHaveBeenCalled();
  });

  it('cancelling a trip never runs the check', async () => {
    const self = { id: 'trp_1', status: 'PLANNED', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null };
    const { service, repo } = buildService(self);
    await service.update('trp_1', { status: 'CANCELLED', plannedEndAt: at(18) });
    expect(repo.findUnitScheduleCandidates).not.toHaveBeenCalled();
  });

  it('assign onto a new unit rejects an overlap there, excluding itself', async () => {
    const self = { id: 'trp_1', status: 'PLANNED', vehicleId: null, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null, trailerId: null };
    const { service, repo } = buildService(self);
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(service.assign('trp_1', { driverId: 'drv_1', vehicleId: VEH, notify: false })).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
    expect(repo.findUnitScheduleCandidates).toHaveBeenCalledWith(VEH, { start: at(12), end: at(16) }, 'trp_1', 'tx');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('assign keeping the same unit does not re-check', async () => {
    const self = { id: 'trp_1', status: 'ASSIGNED', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null, trailerId: null };
    const { service, repo } = buildService(self);
    await service.assign('trp_1', { driverId: 'drv_2', vehicleId: VEH, notify: false });
    expect(repo.findUnitScheduleCandidates).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalled();
  });
});

/** The spec's example: Unit 1 already holds a trip Oct 10 12:00 → Oct 20 12:00. */
describe('TripsService — unit overlap, spec examples (existing Unit 1: Oct 10 12:00 → Oct 20 12:00)', () => {
  const UNIT_1 = '66666666-6666-4666-8666-666666666666';
  const UNIT_2 = '77777777-7777-4777-8777-777777777777';
  const oct = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour));
  const existing = {
    id: 'trp_existing',
    number: 'TRP-500',
    status: 'ASSIGNED',
    plannedStartAt: oct(10, 12),
    plannedEndAt: oct(20, 12),
    startedAt: null,
    completedAt: null,
    vehicle: { unitNumber: '1' },
  };
  const EXPECTED_MESSAGE = 'Unit 1 is already assigned to another trip (TRP-500) from 2026-10-10 12:00 UTC to 2026-10-20 12:00 UTC.';

  /** The repository mock returns the existing trip only for the unit it is on. */
  function serviceWithExisting(self: Record<string, unknown> | null = null) {
    const built = buildService(self);
    built.repo.findUnitScheduleCandidates.mockImplementation(async (...args: unknown[]) => (args[0] === UNIT_1 ? [existing] : []));
    return built;
  }

  it.each([
    ['overlapping, inside the existing trip', oct(15, 10), oct(18, 12)],
    ['partially overlapping its start', oct(8), oct(12)],
    ['partially overlapping its end', oct(18), oct(22)],
    ['completely containing it', oct(1), oct(30)],
    ['contained inside it', oct(11), oct(19)],
    ['the same start time', oct(10, 12), oct(12)],
    ['the same end time', oct(15), oct(20, 12)],
    ['the identical range', oct(10, 12), oct(20, 12)],
  ])('create rejects %s', async (_label, start, end) => {
    const { service, repo } = serviceWithExisting();
    await expect(
      service.create({ number: 'NEW-1', vehicleId: UNIT_1, plannedStartAt: start, plannedEndAt: end, draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT', status: 409, message: EXPECTED_MESSAGE });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it.each([
    ['back-to-back after it (Oct 20 12:00 → Oct 25)', oct(20, 12), oct(25)],
    ['back-to-back before it (Oct 5 → Oct 10 12:00)', oct(5), oct(10, 12)],
    ['entirely after it (Oct 21 → Oct 25)', oct(21), oct(25)],
    ['entirely before it (Oct 1 → Oct 5)', oct(1), oct(5)],
  ])('create allows %s', async (_label, start, end) => {
    const { service, repo } = serviceWithExisting();
    await service.create({ number: 'NEW-2', vehicleId: UNIT_1, plannedStartAt: start, plannedEndAt: end, draft: false }, 'usr_1');
    expect(repo.createWithStops).toHaveBeenCalledTimes(1);
  });

  it('create allows the same range on a different unit', async () => {
    const { service, repo } = serviceWithExisting();
    await service.create({ number: 'NEW-3', vehicleId: UNIT_2, plannedStartAt: oct(15, 10), plannedEndAt: oct(18, 12), draft: false }, 'usr_1');
    expect(repo.createWithStops).toHaveBeenCalledTimes(1);
  });

  it('update of the existing trip itself without changing its dates is allowed (no self-conflict)', async () => {
    const { service, repo } = serviceWithExisting({ ...existing, vehicleId: UNIT_1, etaAt: null });
    await service.update('trp_existing', { plannedStartAt: oct(10, 12), plannedEndAt: oct(20, 12), notes: 'same dates' });
    expect(repo.findUnitScheduleCandidates).toHaveBeenCalledWith(UNIT_1, { start: oct(10, 12), end: oct(20, 12) }, 'trp_existing', 'tx');
    expect(repo.update).toHaveBeenCalledTimes(1);
  });

  it('update of another trip on Unit 1 into the existing range is rejected', async () => {
    const mine = { id: 'trp_mine', number: 'TRP-600', status: 'PLANNED', vehicleId: UNIT_1, plannedStartAt: oct(21), plannedEndAt: oct(25), etaAt: null };
    const { service, repo } = serviceWithExisting(mine);
    await expect(service.update('trp_mine', { plannedStartAt: oct(19), plannedEndAt: oct(25) })).rejects.toMatchObject({
      code: 'TRIP_SCHEDULE_CONFLICT',
      message: EXPECTED_MESSAGE,
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('a different driver/route does not matter — only the unit id is compared', async () => {
    const { service } = serviceWithExisting();
    await expect(
      service.create({ number: 'NEW-4', vehicleId: UNIT_1, driverId: '88888888-8888-4888-8888-888888888888', plannedStartAt: oct(15), plannedEndAt: oct(16), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
  });
});
