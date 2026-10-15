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
    findDriverForTrip: jest.fn(async (id: string): Promise<{ id: string; status: string; deletedAt: Date | null } | null> => ({ id, status: 'ACTIVE', deletedAt: null })),
    findVehicleForTrip: jest.fn(async (id: string): Promise<{ id: string; status: string; deletedAt: Date | null } | null> => ({ id, status: 'ACTIVE', deletedAt: null })),
    findTrailer: jest.fn(async (id: string): Promise<{ id: string; status: string; deletedAt: Date | null } | null> => ({ id, status: 'ACTIVE', deletedAt: null })),
    findUnitScheduleCandidates: jest.fn(async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => []),
    withUnitScheduleLock: jest.fn(async (_vehicleId: string, work: (db: unknown) => Promise<unknown>, outer?: unknown) => work(outer ?? 'tx')),
    findDriverScheduleCandidates: jest.fn(async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => []),
    withDriverScheduleLock: jest.fn(async (_driverId: string, work: (db: unknown) => Promise<unknown>, outer?: unknown) => work(outer ?? 'tx')),
    findTrailerScheduleCandidates: jest.fn(async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => []),
    withTrailerScheduleLock: jest.fn(async (_trailerId: string, work: (db: unknown) => Promise<unknown>, outer?: unknown) => work(outer ?? 'tx')),
    findTrailerNumber: jest.fn(async (_id: string, _db?: unknown): Promise<string | null> => 'T-77'),
    hardDelete: jest.fn(async (_id: string) => true),
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
  it('allows PLANNED -> ASSIGNED when the trip already has a driver', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: 'drv_1', etaAt: null });
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

  it('LIVE-012 — Start trip is a 409 while the driver is still on another IN_PROGRESS trip', async () => {
    const { service, repo } = buildService({
      id: 'trp_1', number: 'TRP-1', status: 'ASSIGNED', driverId: 'drv_1', vehicleId: 'veh_1', trailerId: null, etaAt: null, startedAt: null,
      plannedStartAt: new Date('2026-10-14T08:00:00Z'), plannedEndAt: new Date('2026-10-14T18:00:00Z'),
    });
    repo.findDriverScheduleCandidates.mockResolvedValueOnce([
      { id: 'trp_old', number: 'TRP-OLD', status: 'IN_PROGRESS', plannedStartAt: new Date('2026-10-06T08:00:00Z'), plannedEndAt: new Date('2026-10-06T16:00:00Z'), startedAt: new Date('2026-10-06T08:00:00Z'), completedAt: null, driver: { firstName: 'Tom', lastName: 'A' } },
    ]);
    await expect(service.update('trp_1', { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT', status: 409 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('LIVE-033 — Start trip is a 409 when the unit has gone out of service', async () => {
    const { service, repo } = buildService({
      id: 'trp_1', status: 'ASSIGNED', driverId: 'drv_1', vehicleId: 'veh_1', trailerId: null, etaAt: null, startedAt: null,
      plannedStartAt: new Date('2026-10-14T08:00:00Z'), plannedEndAt: null,
    });
    repo.findVehicleForTrip.mockResolvedValueOnce({ id: 'veh_1', status: 'OUT_OF_SERVICE', deletedAt: null });
    await expect(service.update('trp_1', { status: 'IN_PROGRESS' })).rejects.toMatchObject({ code: 'VEHICLE_OUT_OF_SERVICE', status: 409 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('publishes trip.status_changed only when the status actually changes', async () => {
    const { service, events } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    await service.update('trp_1', { notes: 'no status change' });
    // CODE-056 — an edit without a status move tells other boards with `trip.updated` instead.
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith('realtime.push', { room: 'fleet', event: 'trip.updated', payload: { tripId: 'trp_1' } });
  });
});

describe('TripsService — assign', () => {
  it('rejects assigning a trip that is already IN_PROGRESS', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'IN_PROGRESS', etaAt: null });
    await expect(service.assign('trp_1', { driverId: 'drv_1', notify: true })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('assigns a PLANNED trip and raises alert.trip_assigned', async () => {
    const { service, alertQueue } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null, plannedStartAt: new Date('2026-10-10T10:00:00Z'), plannedEndAt: new Date('2026-10-10T18:00:00Z') });
    const result = await service.assign('trp_1', { driverId: 'drv_1', notify: true });
    expect(result.status).toBe('ASSIGNED');
    expect(alertQueue.add).toHaveBeenCalledWith('alert.trip_assigned', { tripId: 'trp_1', driverId: 'drv_1' });
  });

  it('§20 B-74 — notify: false assigns without raising the driver-app notification', async () => {
    const { service, alertQueue } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null, plannedStartAt: new Date('2026-10-10T10:00:00Z'), plannedEndAt: new Date('2026-10-10T18:00:00Z') });
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
    await service.create({ number: 'TRP-11', trailerId: TRL, plannedStartAt: new Date('2026-10-10T10:00:00Z'), plannedEndAt: new Date('2026-10-10T18:00:00Z'), draft: false }, 'usr_1');
    expect(repo.findTrailer).toHaveBeenCalledWith(TRL, undefined);
    expect((repo.createWithStops.mock.calls[0][0] as Record<string, unknown>).trailerId).toBe(TRL);
  });

  it('BE-06 — re-reads the trailer under its schedule lock: a delete that won the race is a 422, nothing written', async () => {
    const { service, repo } = buildService();
    repo.findTrailer
      .mockResolvedValueOnce({ id: TRL, status: 'ACTIVE', deletedAt: null })
      .mockResolvedValueOnce({ id: TRL, status: 'INACTIVE', deletedAt: new Date('2026-10-01T00:00:00Z') });
    await expect(
      service.create({ number: 'TRP-15', trailerId: TRL, plannedStartAt: new Date('2026-10-10T10:00:00Z'), plannedEndAt: new Date('2026-10-10T18:00:00Z'), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ code: 'TRAILER_NOT_FOUND', status: 422 });
    expect(repo.findTrailer).toHaveBeenLastCalledWith(TRL, 'tx');
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('create rejects a soft-deleted trailerId with 422 TRAILER_NOT_FOUND and writes nothing', async () => {
    const { service, repo } = buildService();
    repo.findTrailer.mockResolvedValueOnce({ id: TRL, status: 'ACTIVE', deletedAt: new Date('2026-10-01T00:00:00Z') });
    await expect(service.create({ number: 'TRP-12', trailerId: TRL, draft: false }, 'usr_1')).rejects.toMatchObject({
      code: 'TRAILER_NOT_FOUND',
      status: 422,
      details: { trailerId: 'This trailer has been deleted and cannot be assigned.' },
    });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it.each([
    ['OUT_OF_SERVICE', /out of service/],
    ['INACTIVE', /inactive/],
  ])('CODE-049 — create rejects a %s trailer with 409 and writes nothing', async (status, text) => {
    const { service, repo } = buildService();
    repo.findTrailer.mockResolvedValueOnce({ id: TRL, status, deletedAt: null });
    await expect(service.create({ number: 'TRP-14', trailerId: TRL, draft: false }, 'usr_1')).rejects.toMatchObject({
      status: 409,
      details: { trailerId: expect.stringMatching(text) as unknown },
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
    repo.findTrailer.mockResolvedValueOnce({ id: TRL, status: 'ACTIVE', deletedAt: new Date() });
    await expect(service.assign('trp_1', { driverId: 'drv_1', trailerId: TRL, notify: false })).rejects.toMatchObject({ code: 'TRAILER_NOT_FOUND', status: 422 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("assign re-sending the trip's current (since-deleted) trailer is not re-validated", async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'ASSIGNED', etaAt: null, trailerId: TRL, plannedStartAt: new Date('2026-10-10T10:00:00Z'), plannedEndAt: new Date('2026-10-10T18:00:00Z') });
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

  it('CODE-058 create with a unit but no planned end -> 422 details.plannedEndAt (it would hold the unit for ever)', async () => {
    const { service, repo } = buildService();
    await expect(
      service.create({ number: 'TRP-6', vehicleId: VEH, plannedStartAt: at(12), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ status: 422, details: { plannedEndAt: expect.any(String) as string } });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('CODE-062 a unit deleted after the pre-check is re-read under the schedule lock -> 422, nothing written', async () => {
    const { service, repo } = buildService();
    repo.findVehicleForTrip
      .mockResolvedValueOnce({ id: VEH, status: 'ACTIVE', deletedAt: null })
      .mockResolvedValueOnce({ id: VEH, status: 'INACTIVE', deletedAt: new Date('2026-10-10T00:00:00Z') });
    await expect(
      service.create({ number: 'TRP-62', vehicleId: VEH, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ status: 422, code: 'VEHICLE_NOT_FOUND' });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('CODE-062 (driver) a driver deleted after the pre-check is re-read under the driver lock -> 422, nothing written', async () => {
    const DRV = '11111111-1111-4111-8111-111111111111';
    const { service, repo } = buildService();
    repo.findDriverForTrip
      .mockResolvedValueOnce({ id: DRV, status: 'ACTIVE', deletedAt: null })
      .mockResolvedValueOnce({ id: DRV, status: 'TERMINATED', deletedAt: new Date('2026-10-10T00:00:00Z') });
    await expect(
      service.create({ number: 'TRP-62D', driverId: DRV, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ status: 422, code: 'DRIVER_NOT_FOUND' });
    expect(repo.withDriverScheduleLock).toHaveBeenCalled();
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('CODE-062 (driver) assign: a driver deactivated after the pre-check -> 409 details.driverId, nothing written', async () => {
    const DRV = '11111111-1111-4111-8111-111111111111';
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: null, vehicleId: null, trailerId: null, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null });
    repo.findDriverForTrip
      .mockResolvedValueOnce({ id: DRV, status: 'ACTIVE', deletedAt: null })
      .mockResolvedValueOnce({ id: DRV, status: 'INACTIVE', deletedAt: null });
    await expect(service.assign('trp_1', { driverId: DRV, notify: false })).rejects.toMatchObject({
      status: 409,
      details: { driverId: expect.stringContaining('inactive') as string },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('CODE-058 a draft with a unit may still be saved without a planned end', async () => {
    const { service, repo } = buildService();
    await service.create({ number: 'TRP-6D', vehicleId: VEH, plannedStartAt: at(12), draft: true }, 'usr_1');
    expect(repo.createWithStops).toHaveBeenCalled();
  });

  it('CODE-058 assign on a trip with no planned end -> 422 details.plannedEndAt', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: null, vehicleId: null, trailerId: null, plannedStartAt: at(12), plannedEndAt: null, etaAt: null });
    await expect(service.assign('trp_1', { driverId: '11111111-1111-4111-8111-111111111111', notify: false })).rejects.toMatchObject({
      status: 422,
      details: { plannedEndAt: expect.any(String) as string },
    });
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
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'trp_1' }), expect.anything(), 'tx', { pickupAt: undefined, deliveryAt: at(16) });
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

describe('TripsService — driver and trailer overlap (TRIP_SCHEDULE_CONFLICT)', () => {
  const VEH = '44444444-4444-4444-8444-444444444444';
  const DRV = '99999999-9999-4999-8999-999999999999';
  const TRL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
    driver: { firstName: 'John', lastName: 'Smith' },
    ...o,
  });
  const DRIVER_MSG = 'Driver John Smith is already assigned to another trip (TRP-500) from 2026-10-10 10:00 UTC to 2026-10-10 14:00 UTC.';
  const MSG_UNIT = 'Unit 101 is already assigned to another trip (TRP-500) from 2026-10-10 10:00 UTC to 2026-10-10 14:00 UTC.';
  const TRAILER_MSG = 'Trailer T-77 is already assigned to another trip (TRP-500) from 2026-10-10 10:00 UTC to 2026-10-10 14:00 UTC.';

  type Resource = 'driver' | 'trailer';
  const cases: Array<[Resource, string, string, 'findDriverScheduleCandidates' | 'findTrailerScheduleCandidates', 'withDriverScheduleLock' | 'withTrailerScheduleLock', 'driverId' | 'trailerId']> = [
    ['driver', DRV, DRIVER_MSG, 'findDriverScheduleCandidates', 'withDriverScheduleLock', 'driverId'],
    ['trailer', TRL, TRAILER_MSG, 'findTrailerScheduleCandidates', 'withTrailerScheduleLock', 'trailerId'],
  ];

  describe.each(cases)('%s', (resource, ID, MSG, finder, lock, field) => {
    it(`create rejects an overlapping trip on the same ${resource} with 409 naming the resource and the other trip`, async () => {
      const { service, repo } = buildService();
      repo[finder].mockResolvedValueOnce([other()]);
      await expect(
        service.create({ number: 'TRP-1', [field]: ID, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1'),
      ).rejects.toMatchObject({
        code: 'TRIP_SCHEDULE_CONFLICT',
        status: 409,
        message: MSG,
        details: {
          [field]: MSG,
          conflict: {
            resource,
            tripId: 'trp_other',
            number: 'TRP-500',
            status: 'ASSIGNED',
            unitNumber: '101',
            ...(resource === 'driver' ? { driverName: 'John Smith' } : { trailerNumber: 'T-77' }),
            start: at(10).toISOString(),
            end: at(14).toISOString(),
          },
        },
      });
      expect(repo[lock]).toHaveBeenCalledWith(ID, expect.any(Function));
      expect(repo[finder]).toHaveBeenCalledWith(ID, { start: at(12), end: at(16) }, undefined, 'tx');
      expect(repo.createWithStops).not.toHaveBeenCalled();
    });

    it('create allows a trip that starts exactly when the other one ends (touching endpoints)', async () => {
      const { service, repo } = buildService();
      repo[finder].mockResolvedValueOnce([other()]);
      await service.create({ number: 'TRP-2', [field]: ID, plannedStartAt: at(14), plannedEndAt: at(18), draft: false }, 'usr_1');
      expect(repo.createWithStops).toHaveBeenCalledWith(expect.anything(), [], 'tx');
    });

    it('create allows a trip that ends exactly when the other one starts (touching endpoints)', async () => {
      const { service, repo } = buildService();
      repo[finder].mockResolvedValueOnce([other()]);
      await service.create({ number: 'TRP-2b', [field]: ID, plannedStartAt: at(6), plannedEndAt: at(10), draft: false }, 'usr_1');
      expect(repo.createWithStops).toHaveBeenCalled();
    });

    it('an open-ended (no planned end) trip blocks everything after its start', async () => {
      const { service, repo } = buildService();
      repo[finder].mockResolvedValueOnce([other({ plannedEndAt: null })]);
      await expect(
        service.create({ number: 'TRP-3', [field]: ID, plannedStartAt: at(30), plannedEndAt: at(34), draft: false }, 'usr_1'),
      ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT', message: MSG.replace('to 2026-10-10 14:00 UTC.', 'onward (no planned end).') });
    });

    it('create ignores a CANCELLED trip in the same range', async () => {
      const { service, repo } = buildService();
      repo[finder].mockResolvedValueOnce([other({ status: 'CANCELLED' })]);
      await service.create({ number: 'TRP-4', [field]: ID, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1');
      expect(repo.createWithStops).toHaveBeenCalled();
    });

    it(`a draft with a ${resource} is checked too, and an existing DRAFT blocks`, async () => {
      const { service, repo } = buildService();
      repo[finder].mockResolvedValueOnce([other()]);
      await expect(
        service.create({ number: 'TRP-5', [field]: ID, plannedStartAt: at(12), plannedEndAt: at(16), draft: true }, 'usr_1'),
      ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
      repo[finder].mockResolvedValueOnce([other({ status: 'DRAFT' })]);
      await expect(
        service.create({ number: 'TRP-5b', [field]: ID, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1'),
      ).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
      expect(repo.createWithStops).not.toHaveBeenCalled();
    });

    it('a draft without a start is never checked', async () => {
      const { service, repo } = buildService();
      await service.create({ number: 'TRP-6', [field]: ID, draft: true }, 'usr_1');
      expect(repo[finder]).not.toHaveBeenCalled();
      expect(repo[lock]).not.toHaveBeenCalled();
    });

    it('update re-checks a moved range, excluding the trip itself', async () => {
      const self = { id: 'trp_1', status: 'ASSIGNED', vehicleId: null, driverId: null, trailerId: null, [field]: ID, plannedStartAt: at(10), plannedEndAt: at(14), etaAt: null };
      const { service, repo } = buildService(self);
      repo[finder].mockResolvedValueOnce([other({ id: 'trp_1', number: 'TRP-1' })]);
      await service.update('trp_1', { plannedEndAt: at(16) });
      expect(repo[finder]).toHaveBeenCalledWith(ID, { start: at(10), end: at(16) }, 'trp_1', 'tx');
      expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'trp_1' }), expect.anything(), 'tx', { pickupAt: undefined, deliveryAt: at(16) });
    });

    it('update rejects a moved range that overlaps another trip', async () => {
      const self = { id: 'trp_1', status: 'PLANNED', vehicleId: null, driverId: null, trailerId: null, [field]: ID, plannedStartAt: at(0), plannedEndAt: at(4), etaAt: null };
      const { service, repo } = buildService(self);
      repo[finder].mockResolvedValueOnce([other()]);
      await expect(service.update('trp_1', { plannedStartAt: at(9), plannedEndAt: at(11) })).rejects.toMatchObject({
        code: 'TRIP_SCHEDULE_CONFLICT',
        status: 409,
        message: MSG,
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('publishing a DRAFT checks it; a plain field edit does not', async () => {
      const self = { id: 'trp_1', status: 'DRAFT', vehicleId: null, driverId: null, trailerId: null, [field]: ID, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null };
      const { service, repo } = buildService(self);
      repo[finder].mockResolvedValueOnce([other()]);
      await expect(service.update('trp_1', { status: 'PLANNED' })).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT' });
      repo[finder].mockClear();
      await service.update('trp_1', { notes: 'x' });
      expect(repo[finder]).not.toHaveBeenCalled();
    });
  });

  it('assign onto a new driver rejects an overlap there, excluding itself', async () => {
    const self = { id: 'trp_1', status: 'PLANNED', vehicleId: null, driverId: null, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null, trailerId: null };
    const { service, repo } = buildService(self);
    repo.findDriverScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(service.assign('trp_1', { driverId: DRV, notify: false })).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT', message: DRIVER_MSG });
    expect(repo.findDriverScheduleCandidates).toHaveBeenCalledWith(DRV, { start: at(12), end: at(16) }, 'trp_1', 'tx');
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('assign onto a new trailer rejects an overlap there, excluding itself', async () => {
    const self = { id: 'trp_1', status: 'ASSIGNED', vehicleId: null, driverId: DRV, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null, trailerId: null };
    const { service, repo } = buildService(self);
    repo.findTrailerScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(service.assign('trp_1', { driverId: DRV, trailerId: TRL, notify: false })).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT', message: TRAILER_MSG });
    expect(repo.findTrailerScheduleCandidates).toHaveBeenCalledWith(TRL, { start: at(12), end: at(16) }, 'trp_1', 'tx');
    expect(repo.findDriverScheduleCandidates).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('assign allows touching endpoints on the new driver/trailer', async () => {
    const self = { id: 'trp_1', status: 'PLANNED', vehicleId: null, driverId: null, plannedStartAt: at(14), plannedEndAt: at(18), etaAt: null, trailerId: null };
    const { service, repo } = buildService(self);
    repo.findDriverScheduleCandidates.mockResolvedValueOnce([other()]);
    repo.findTrailerScheduleCandidates.mockResolvedValueOnce([other()]);
    await service.assign('trp_1', { driverId: DRV, trailerId: TRL, notify: false });
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'trp_1' }), expect.anything(), 'tx');
  });

  it('assign keeping the same driver and trailer does not re-check them', async () => {
    const self = { id: 'trp_1', status: 'ASSIGNED', vehicleId: VEH, driverId: DRV, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null, trailerId: TRL };
    const { service, repo } = buildService(self);
    await service.assign('trp_1', { driverId: DRV, vehicleId: VEH, trailerId: TRL, notify: false });
    expect(repo.findDriverScheduleCandidates).not.toHaveBeenCalled();
    expect(repo.findTrailerScheduleCandidates).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'trp_1' }), expect.anything());
  });

  it('nests the locks vehicle -> driver -> trailer in one transaction, skipping null ids', async () => {
    const { service, repo } = buildService();
    const order: string[] = [];
    repo.withUnitScheduleLock.mockImplementationOnce(async (_id, work, outer) => (order.push('vehicle'), work(outer ?? 'tx')));
    repo.withDriverScheduleLock.mockImplementationOnce(async (_id, work, outer) => (order.push(`driver:${String(outer)}`), work(outer ?? 'tx')));
    repo.withTrailerScheduleLock.mockImplementationOnce(async (_id, work, outer) => (order.push(`trailer:${String(outer)}`), work(outer ?? 'tx')));
    await service.create({ number: 'TRP-L1', vehicleId: VEH, driverId: DRV, trailerId: TRL, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1');
    expect(order).toEqual(['vehicle', 'driver:tx', 'trailer:tx']);
    expect(repo.withUnitScheduleLock).toHaveBeenCalledWith(VEH, expect.any(Function));
    expect(repo.withDriverScheduleLock).toHaveBeenCalledWith(DRV, expect.any(Function), 'tx');
    expect(repo.withTrailerScheduleLock).toHaveBeenCalledWith(TRL, expect.any(Function), 'tx');

    order.length = 0;
    repo.withDriverScheduleLock.mockClear();
    repo.withTrailerScheduleLock.mockImplementationOnce(async (_id, work, outer) => (order.push(`trailer:${String(outer)}`), work(outer ?? 'tx')));
    await service.create({ number: 'TRP-L2', trailerId: TRL, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1');
    expect(order).toEqual(['trailer:undefined']);
    expect(repo.withDriverScheduleLock).not.toHaveBeenCalled();
  });

  it('a vehicle conflict carries resource: vehicle and is checked before the driver', async () => {
    const { service, repo } = buildService();
    repo.findUnitScheduleCandidates.mockResolvedValueOnce([other()]);
    repo.findDriverScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(
      service.create({ number: 'TRP-V', vehicleId: VEH, driverId: DRV, plannedStartAt: at(12), plannedEndAt: at(16), draft: false }, 'usr_1'),
    ).rejects.toMatchObject({ details: { vehicleId: MSG_UNIT, conflict: { resource: 'vehicle', unitNumber: '101' } } });
    expect(repo.findDriverScheduleCandidates).not.toHaveBeenCalled();
  });

  it('auto-assign skips a load whose driver is already booked and keeps going', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: null, vehicleId: null, trailerId: null, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null });
    repo.unassignedLoads.mockResolvedValueOnce([{ id: 'trp_a', plannedStartAt: at(12), plannedEndAt: at(16) }, { id: 'trp_b', plannedStartAt: at(12), plannedEndAt: at(16) }] as never);
    repo.availableDriverIds.mockResolvedValueOnce([DRV] as never);
    repo.findDriverScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(service.autoAssign()).resolves.toEqual({ assigned: [{ tripId: 'trp_b', driverId: DRV }], skipped: 1, noSchedule: 0, failed: [] });
  });

  it('CODE-055 a booked driver is tried for the next load instead of being dropped, and the next driver is tried for this one', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: null, vehicleId: null, trailerId: null, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null });
    repo.unassignedLoads.mockResolvedValueOnce([{ id: 'trp_a', plannedStartAt: at(12), plannedEndAt: at(16) }] as never);
    repo.availableDriverIds.mockResolvedValueOnce(['drv_busy', 'drv_free'] as never);
    // drv_busy holds an overlapping trip -> TRIP_SCHEDULE_CONFLICT; drv_free fits.
    repo.findDriverScheduleCandidates.mockResolvedValueOnce([other()]);
    await expect(service.autoAssign()).resolves.toEqual({ assigned: [{ tripId: 'trp_a', driverId: 'drv_free' }], skipped: 0, noSchedule: 0, failed: [] });
  });

  it('CODE-055 a load-level error is reported for that load and the run continues (no 500 half-way)', async () => {
    // The load was started meanwhile (stale unassigned-loads read): a load-level 409, not a driver one.
    const { service, repo } = buildService({ id: 'trp_a', status: 'IN_PROGRESS', driverId: null, vehicleId: null, trailerId: null, plannedStartAt: at(12), plannedEndAt: at(16), etaAt: null });
    repo.unassignedLoads.mockResolvedValueOnce([{ id: 'trp_a', number: 'TR-1', plannedStartAt: at(12), plannedEndAt: at(16) }] as never);
    repo.availableDriverIds.mockResolvedValueOnce([DRV, 'drv_2'] as never);
    const result = await service.autoAssign();
    expect(result.assigned).toEqual([]);
    expect(result.failed).toEqual([{ tripId: 'trp_a', number: 'TR-1', reason: expect.stringContaining('planned or assigned') as string }]);
    expect(result.skipped).toBe(0);
  });
});

describe('TripsService — realtime notices (CODE-056)', () => {
  it('create publishes trip.created for other boards', async () => {
    const { service, events } = buildService();
    await service.create({ number: 'TRP-NEW', draft: true }, 'usr_1');
    expect(events.publish).toHaveBeenCalledWith('realtime.push', { room: 'fleet', event: 'trip.created', payload: { tripId: 'trp_new' } });
  });
});

describe('TripsService — hard delete', () => {
  it('404 NOT_FOUND when the trip does not exist', async () => {
    const { service, repo } = buildService(null);
    await expect(service.remove('trp_x')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(repo.hardDelete).not.toHaveBeenCalled();
  });

  it('409 TRIP_IN_PROGRESS for a trip the driver is running', async () => {
    const { service, repo, events } = buildService({ id: 'trp_1', status: 'IN_PROGRESS', etaAt: null });
    await expect(service.remove('trp_1')).rejects.toMatchObject({ code: 'TRIP_IN_PROGRESS', status: 409 });
    expect(repo.hardDelete).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'PLANNED', 'ASSIGNED', 'DELIVERED', 'CANCELLED'])('hard-deletes a %s trip and publishes trip.deleted', async (status) => {
    const { service, repo, events } = buildService({ id: 'trp_1', status, etaAt: null });
    await expect(service.remove('trp_1')).resolves.toBeUndefined();
    expect(repo.hardDelete).toHaveBeenCalledWith('trp_1');
    expect(events.publish).toHaveBeenCalledWith('realtime.push', {
      room: 'fleet',
      event: 'trip.deleted',
      payload: { id: 'trp_1', tripId: 'trp_1' },
    });
  });

  it('409 TRIP_IN_PROGRESS when the trip was started between the check and the delete', async () => {
    const { service, repo, events } = buildService({ id: 'trp_1', status: 'ASSIGNED', etaAt: null });
    repo.hardDelete.mockResolvedValueOnce(false);
    repo.findById.mockResolvedValueOnce({ id: 'trp_1', status: 'ASSIGNED', etaAt: null });
    repo.findById.mockResolvedValueOnce({ id: 'trp_1', status: 'IN_PROGRESS', etaAt: null });
    await expect(service.remove('trp_1')).rejects.toMatchObject({ code: 'TRIP_IN_PROGRESS', status: 409 });
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('404 when the trip was deleted concurrently', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    repo.hardDelete.mockResolvedValueOnce(false);
    repo.findById.mockResolvedValueOnce({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    repo.findById.mockResolvedValueOnce(null);
    await expect(service.remove('trp_1')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('TripsService — finished trips are not editable', () => {
  it.each(['DELIVERED', 'CANCELLED'])('409 TRIP_NOT_EDITABLE when PATCHing fields of a %s trip', async (status) => {
    const { service, repo } = buildService({ id: 'trp_1', status, etaAt: null });
    await expect(service.update('trp_1', { notes: 'late edit' })).rejects.toMatchObject({
      code: 'TRIP_NOT_EDITABLE',
      status: 409,
      details: { status, fields: ['notes'] },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('ignores undefined keys and lets a same-status PATCH through on a DELIVERED trip', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'DELIVERED', etaAt: null });
    await service.update('trp_1', { status: 'DELIVERED', notes: undefined });
    expect(repo.update).toHaveBeenCalled();
  });

  it('a status move out of a terminal trip is still the transition 409 CONFLICT', async () => {
    const { service } = buildService({ id: 'trp_1', status: 'CANCELLED', etaAt: null });
    await expect(service.update('trp_1', { status: 'PLANNED' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('still allows editing fields of an IN_PROGRESS trip', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'IN_PROGRESS', etaAt: null });
    await service.update('trp_1', { notes: 'ok' });
    expect(repo.update).toHaveBeenCalled();
  });
});

describe('TripsService — driver / unit validation (BE-001)', () => {
  const DRV = '11111111-1111-4111-8111-111111111111';
  const VEH = '22222222-2222-4222-8222-222222222222';
  const start = new Date('2026-10-20T10:00:00Z');
  const create = (o: Record<string, unknown> = {}) => ({ number: 'TRP-V1', plannedStartAt: start, draft: false, ...o });

  it('422 DRIVER_NOT_FOUND (details.driverId) for an unknown driver; nothing written', async () => {
    const { service, repo } = buildService();
    repo.findDriverForTrip.mockResolvedValueOnce(null);
    await expect(service.create(create({ driverId: DRV }), 'usr_1')).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
      status: 422,
      details: { driverId: 'Driver not found.' },
    });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('422 for a soft-deleted driver, 409 for a TERMINATED / INACTIVE one', async () => {
    const { service, repo } = buildService();
    repo.findDriverForTrip.mockResolvedValueOnce({ id: DRV, status: 'TERMINATED', deletedAt: new Date() });
    await expect(service.create(create({ driverId: DRV }), 'usr_1')).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND', status: 422 });
    repo.findDriverForTrip.mockResolvedValueOnce({ id: DRV, status: 'TERMINATED', deletedAt: null });
    await expect(service.create(create({ driverId: DRV }), 'usr_1')).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    repo.findDriverForTrip.mockResolvedValueOnce({ id: DRV, status: 'INACTIVE', deletedAt: null });
    await expect(service.create(create({ driverId: DRV }), 'usr_1')).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('422 VEHICLE_NOT_FOUND for an unknown / deleted unit, 409 VEHICLE_OUT_OF_SERVICE for an OOS unit', async () => {
    const { service, repo } = buildService();
    repo.findVehicleForTrip.mockResolvedValueOnce(null);
    await expect(service.create(create({ vehicleId: VEH }), 'usr_1')).rejects.toMatchObject({
      code: 'VEHICLE_NOT_FOUND',
      status: 422,
      details: { vehicleId: 'Vehicle not found.' },
    });
    repo.findVehicleForTrip.mockResolvedValueOnce({ id: VEH, status: 'INACTIVE', deletedAt: new Date() });
    await expect(service.create(create({ vehicleId: VEH }), 'usr_1')).rejects.toMatchObject({ code: 'VEHICLE_NOT_FOUND', status: 422 });
    repo.findVehicleForTrip.mockResolvedValueOnce({ id: VEH, status: 'OUT_OF_SERVICE', deletedAt: null });
    await expect(service.create(create({ vehicleId: VEH }), 'usr_1')).rejects.toMatchObject({
      code: 'VEHICLE_OUT_OF_SERVICE',
      status: 409,
      details: { vehicleId: 'This unit is out of service and cannot be assigned a trip.' },
    });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('maps a P2025 (driver/unit deleted between pre-check and write) to 422, not 500', async () => {
    const { service, repo } = buildService();
    repo.createWithStops.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'P2025' }));
    await expect(service.create(create({ driverId: DRV }), 'usr_1')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('assign validates a NEW driver / unit (TERMINATED driver -> 409, OOS unit -> 409)', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: null, vehicleId: null, plannedStartAt: start, etaAt: null });
    repo.findDriverForTrip.mockResolvedValueOnce({ id: DRV, status: 'TERMINATED', deletedAt: null });
    await expect(service.assign('trp_1', { driverId: DRV, notify: false })).rejects.toMatchObject({ status: 409 });
    repo.findVehicleForTrip.mockResolvedValueOnce({ id: VEH, status: 'OUT_OF_SERVICE', deletedAt: null });
    await expect(service.assign('trp_1', { driverId: DRV, vehicleId: VEH, notify: false })).rejects.toMatchObject({ code: 'VEHICLE_OUT_OF_SERVICE' });
    repo.findDriverForTrip.mockResolvedValueOnce(null);
    await expect(service.assign('trp_1', { driverId: DRV, notify: false })).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND', status: 422 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("assign does not re-validate the trip's current driver / unit", async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'ASSIGNED', driverId: DRV, vehicleId: VEH, plannedStartAt: start, etaAt: null });
    await service.assign('trp_1', { driverId: DRV, vehicleId: VEH, notify: false });
    expect(repo.findDriverForTrip).not.toHaveBeenCalled();
    expect(repo.findVehicleForTrip).not.toHaveBeenCalled();
  });

  it('assign maps P2025 to 404 when the trip itself vanished', async () => {
    const end = new Date(start.getTime() + 8 * 3600_000);
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: null, plannedStartAt: start, plannedEndAt: end, etaAt: null });
    repo.withDriverScheduleLock.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'P2025' }));
    repo.findById.mockResolvedValueOnce({ id: 'trp_1', status: 'PLANNED', driverId: null, plannedStartAt: start, plannedEndAt: end, etaAt: null }).mockResolvedValueOnce(null);
    await expect(service.assign('trp_1', { driverId: DRV, notify: false })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});

describe('TripsService — planned start required for resources (BE-005)', () => {
  const DRV = '11111111-1111-4111-8111-111111111111';

  it('create with a driver but no planned start -> 422 details.plannedStartAt', async () => {
    const { service, repo } = buildService();
    await expect(service.create({ number: 'TRP-S', driverId: DRV, draft: false }, 'usr_1')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      details: { plannedStartAt: 'Set a planned start before putting a driver, unit or trailer on this trip.' },
    });
    expect(repo.createWithStops).not.toHaveBeenCalled();
  });

  it('a draft may still be saved without a start; a trip with no resources too', async () => {
    const { service, repo } = buildService();
    await service.create({ number: 'TRP-D', driverId: DRV, draft: true }, 'usr_1');
    await service.create({ number: 'TRP-E', draft: false }, 'usr_1');
    expect(repo.createWithStops).toHaveBeenCalledTimes(2);
  });

  it('publishing a draft that holds a driver but has no start -> 422', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'DRAFT', driverId: DRV, vehicleId: null, trailerId: null, plannedStartAt: null, etaAt: null });
    await expect(service.update('trp_1', { status: 'PLANNED' })).rejects.toMatchObject({ status: 422, details: { plannedStartAt: 'Set a planned start before putting a driver, unit or trailer on this trip.' } });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('assign on a trip with no planned start -> 422; auto-assign skips such loads', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: null, plannedStartAt: null, etaAt: null });
    await expect(service.assign('trp_1', { driverId: DRV, notify: false })).rejects.toMatchObject({ status: 422 });
    repo.unassignedLoads.mockResolvedValueOnce([{ id: 'trp_1', plannedStartAt: null }] as never);
    repo.availableDriverIds.mockResolvedValueOnce([DRV] as never);
    await expect(service.autoAssign()).resolves.toEqual({ assigned: [], skipped: 1, noSchedule: 1, failed: [] });
  });
});

describe('TripsService — ASSIGNED <-> PLANNED transitions (BE-011)', () => {
  it('PLANNED -> ASSIGNED without a driver is refused (409, details.driverId)', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'PLANNED', driverId: null, etaAt: null });
    await expect(service.update('trp_1', { status: 'ASSIGNED' })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { driverId: 'Assign a driver to this trip before marking it assigned.' },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('ASSIGNED -> PLANNED takes the driver off the trip', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'ASSIGNED', driverId: 'drv_1', etaAt: null });
    await service.update('trp_1', { status: 'PLANNED' });
    expect(repo.update.mock.calls[0][1]).toMatchObject({ status: 'PLANNED', driver: { disconnect: true } });
  });
});

describe('TripsService — publishing a draft with a driver (CODE-005)', () => {
  const DRV = '11111111-1111-4111-8111-111111111111';
  const VEH = '44444444-4444-4444-8444-444444444444';
  const TRL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h));
  const draft = (o: Record<string, unknown> = {}) => ({
    id: 'trp_1',
    status: 'DRAFT',
    driverId: DRV,
    vehicleId: VEH,
    trailerId: null,
    plannedStartAt: at(12),
    plannedEndAt: at(16),
    etaAt: null,
    ...o,
  });

  it('publishes straight to ASSIGNED, notifies the driver and pushes the new status', async () => {
    const { service, repo, events, alertQueue } = buildService(draft());
    const result = await service.update('trp_1', { status: 'PLANNED' });
    expect(result.status).toBe('ASSIGNED');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ status: 'ASSIGNED' });
    expect(alertQueue.add).toHaveBeenCalledWith('alert.trip_assigned', { tripId: 'trp_1', driverId: DRV });
    expect(events.publish).toHaveBeenCalledWith('realtime.push', {
      room: 'fleet',
      event: 'trip.status_changed',
      payload: { tripId: 'trp_1', status: 'ASSIGNED', eta: null },
    });
  });

  it('re-runs the driver / unit / trailer overlap check under the schedule locks', async () => {
    const { service, repo } = buildService(draft({ trailerId: TRL }));
    await service.update('trp_1', { status: 'PLANNED' });
    expect(repo.findUnitScheduleCandidates).toHaveBeenCalledWith(VEH, { start: at(12), end: at(16) }, 'trp_1', 'tx');
    expect(repo.findDriverScheduleCandidates).toHaveBeenCalledWith(DRV, { start: at(12), end: at(16) }, 'trp_1', 'tx');
    expect(repo.findTrailerScheduleCandidates).toHaveBeenCalledWith(TRL, { start: at(12), end: at(16) }, 'trp_1', 'tx');
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'trp_1' }), expect.objectContaining({ status: 'ASSIGNED' }), 'tx');
  });

  it('a driver booked on another trip in the range -> 409 TRIP_SCHEDULE_CONFLICT, nothing written, no notification', async () => {
    const { service, repo, alertQueue } = buildService(draft({ vehicleId: null }));
    repo.findDriverScheduleCandidates.mockResolvedValueOnce([
      { id: 'trp_other', number: 'TRP-500', status: 'ASSIGNED', plannedStartAt: at(10), plannedEndAt: at(14), startedAt: null, completedAt: null, vehicle: null, driver: { firstName: 'John', lastName: 'Smith' } },
    ]);
    await expect(service.update('trp_1', { status: 'PLANNED' })).rejects.toMatchObject({ code: 'TRIP_SCHEDULE_CONFLICT', status: 409 });
    expect(repo.update).not.toHaveBeenCalled();
    expect(alertQueue.add).not.toHaveBeenCalled();
  });

  it('a driver deactivated since the draft was saved -> 409 details.driverId, nothing written', async () => {
    const { service, repo, alertQueue } = buildService(draft());
    repo.findDriverForTrip.mockResolvedValueOnce({ id: DRV, status: 'INACTIVE', deletedAt: null });
    await expect(service.update('trp_1', { status: 'PLANNED' })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { driverId: 'This driver is inactive and cannot be assigned a trip.' },
    });
    expect(repo.update).not.toHaveBeenCalled();
    expect(alertQueue.add).not.toHaveBeenCalled();
  });

  it('a unit put out of service / a deleted driver since the draft was saved is refused too', async () => {
    const { service, repo } = buildService(draft());
    repo.findVehicleForTrip.mockResolvedValueOnce({ id: VEH, status: 'OUT_OF_SERVICE', deletedAt: null });
    await expect(service.update('trp_1', { status: 'PLANNED' })).rejects.toMatchObject({ code: 'VEHICLE_OUT_OF_SERVICE', status: 409 });
    repo.findDriverForTrip.mockResolvedValueOnce({ id: DRV, status: 'ACTIVE', deletedAt: new Date() });
    await expect(service.update('trp_1', { status: 'PLANNED' })).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND', status: 422 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('a draft without a driver still publishes to PLANNED (unassigned board), unit re-checked, no notification', async () => {
    const { service, repo, alertQueue } = buildService(draft({ driverId: null }));
    const result = await service.update('trp_1', { status: 'PLANNED' });
    expect(result.status).toBe('PLANNED');
    expect(repo.findVehicleForTrip).toHaveBeenCalledWith(VEH);
    expect(repo.findDriverForTrip).not.toHaveBeenCalled();
    expect(alertQueue.add).not.toHaveBeenCalled();
  });

  it('cancelling a draft re-checks nothing, notifies nobody and needs no planned start', async () => {
    const { service, repo, alertQueue } = buildService(draft({ plannedStartAt: null, plannedEndAt: null }));
    const result = await service.update('trp_1', { status: 'CANCELLED' });
    expect(result.status).toBe('CANCELLED');
    expect(repo.findDriverForTrip).not.toHaveBeenCalled();
    expect(repo.findVehicleForTrip).not.toHaveBeenCalled();
    expect(alertQueue.add).not.toHaveBeenCalled();
  });

  it('PATCH PLANNED -> ASSIGNED on a trip that already has a driver (e.g. a draft published before this fix) gets the same checks + notification', async () => {
    const { service, repo, alertQueue } = buildService(draft({ status: 'PLANNED' }));
    repo.findDriverForTrip.mockResolvedValueOnce({ id: DRV, status: 'TERMINATED', deletedAt: null });
    await expect(service.update('trp_1', { status: 'ASSIGNED' })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(repo.update).not.toHaveBeenCalled();

    const result = await service.update('trp_1', { status: 'ASSIGNED' });
    expect(result.status).toBe('ASSIGNED');
    expect(repo.findDriverScheduleCandidates).toHaveBeenCalledWith(DRV, { start: at(12), end: at(16) }, 'trp_1', 'tx');
    expect(alertQueue.add).toHaveBeenCalledWith('alert.trip_assigned', { tripId: 'trp_1', driverId: DRV });
  });

  it('a plain field edit on an ASSIGNED trip never re-notifies the driver', async () => {
    const { service, alertQueue } = buildService(draft({ status: 'ASSIGNED' }));
    await service.update('trp_1', { notes: 'x' });
    expect(alertQueue.add).not.toHaveBeenCalled();
  });
});

describe('TripsService — onTime stamped on delivery (LIVE-003)', () => {
  const end = new Date('2026-10-10T16:00:00Z');

  afterEach(() => jest.useRealTimers());

  it('delivered before the planned end -> onTime: true; after it -> onTime: false', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-10T15:59:00Z') });
    const early = buildService({ id: 'trp_1', status: 'IN_PROGRESS', plannedEndAt: end, completedAt: null, onTime: null, etaAt: null });
    await early.service.update('trp_1', { status: 'DELIVERED' });
    expect(early.repo.update.mock.calls[0][1]).toMatchObject({ onTime: true, completedAt: new Date('2026-10-10T15:59:00Z') });

    jest.setSystemTime(new Date('2026-10-10T16:01:00Z'));
    const late = buildService({ id: 'trp_1', status: 'IN_PROGRESS', plannedEndAt: end, completedAt: null, onTime: null, etaAt: null });
    await late.service.update('trp_1', { status: 'DELIVERED' });
    expect(late.repo.update.mock.calls[0][1]).toMatchObject({ onTime: false });
  });

  it('leaves onTime alone without a planned end, or when it is already set', async () => {
    const noEnd = buildService({ id: 'trp_1', status: 'IN_PROGRESS', plannedEndAt: null, completedAt: null, onTime: null, etaAt: null });
    await noEnd.service.update('trp_1', { status: 'DELIVERED' });
    expect(noEnd.repo.update.mock.calls[0][1]).not.toHaveProperty('onTime');

    const preset = buildService({ id: 'trp_1', status: 'IN_PROGRESS', plannedEndAt: end, completedAt: null, onTime: true, etaAt: null });
    await preset.service.update('trp_1', { status: 'DELIVERED' });
    expect(preset.repo.update.mock.calls[0][1]).not.toHaveProperty('onTime');
  });
});

describe('TripsService — dispatcher Start trip / Mark delivered (LIVE-003)', () => {
  const started = new Date('2026-10-10T08:00:00Z');
  const end = new Date('2026-10-10T16:00:00Z');

  afterEach(() => jest.useRealTimers());

  it('records the delivery time the dispatcher entered and judges onTime against it', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-10T18:00:00Z') });
    const { service, repo } = buildService({ id: 'trp_1', status: 'IN_PROGRESS', startedAt: started, plannedEndAt: end, completedAt: null, onTime: null, etaAt: null });
    await service.update('trp_1', { status: 'DELIVERED', completedAt: new Date('2026-10-10T15:30:00Z') });
    expect(repo.update.mock.calls[0][1]).toMatchObject({ completedAt: new Date('2026-10-10T15:30:00Z'), onTime: true });
  });

  it('rejects a delivery time in the future, before the start, or without the move to DELIVERED', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-10T18:00:00Z') });
    const { service, repo } = buildService({ id: 'trp_1', status: 'IN_PROGRESS', startedAt: started, plannedEndAt: end, completedAt: null, onTime: null, etaAt: null });
    await expect(service.update('trp_1', { status: 'DELIVERED', completedAt: new Date('2026-10-10T19:00:00Z') })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      details: { completedAt: 'Delivery time cannot be in the future.' },
    });
    await expect(service.update('trp_1', { status: 'DELIVERED', completedAt: new Date('2026-10-10T07:00:00Z') })).rejects.toMatchObject({
      details: { completedAt: 'Delivery time cannot be before the trip started.' },
    });
    await expect(service.update('trp_1', { notes: 'x', completedAt: new Date('2026-10-10T12:00:00Z') })).rejects.toMatchObject({ status: 422 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('Start trip (ASSIGNED -> IN_PROGRESS) publishes trip.status_changed', async () => {
    const { service, events } = buildService({ id: 'trp_1', status: 'ASSIGNED', driverId: 'drv_1', startedAt: null, etaAt: null });
    await service.update('trp_1', { status: 'IN_PROGRESS' });
    expect(events.publish).toHaveBeenCalledWith('realtime.push', {
      room: 'fleet',
      event: 'trip.status_changed',
      payload: { tripId: 'trp_1', status: 'IN_PROGRESS', eta: null },
    });
  });
});

describe('TripsService — status-guarded writes (CODE-024)', () => {
  const gone = () => Object.assign(new Error('not found'), { code: 'P2025' });

  it('update writes only while the trip still has the status it was checked in', async () => {
    const { service, repo } = buildService({ id: 'trp_1', status: 'ASSIGNED', driverId: 'drv_1', startedAt: null, etaAt: null });
    await service.update('trp_1', { status: 'IN_PROGRESS' });
    expect(repo.update.mock.calls[0][0]).toEqual({ id: 'trp_1', status: 'ASSIGNED' });
  });

  it('update -> 409 when the status moved between the check and the write (e.g. cancelled meanwhile)', async () => {
    const { service, repo, events } = buildService({ id: 'trp_1', status: 'IN_PROGRESS', startedAt: null, etaAt: null });
    repo.update.mockRejectedValueOnce(gone());
    repo.findById
      .mockResolvedValueOnce({ id: 'trp_1', status: 'IN_PROGRESS', startedAt: null, etaAt: null })
      .mockResolvedValueOnce({ id: 'trp_1', status: 'CANCELLED', startedAt: null, etaAt: null });
    await expect(service.update('trp_1', { status: 'DELIVERED' })).rejects.toMatchObject({ code: 'CONFLICT', status: 409, details: { status: 'CANCELLED' } });
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('assign -> 409 when the driver started the trip meanwhile (never overwrites IN_PROGRESS)', async () => {
    const start = new Date('2026-10-10T08:00:00Z');
    const DRV = '11111111-1111-4111-8111-111111111111';
    const trip = { id: 'trp_1', status: 'ASSIGNED', driverId: 'drv_old', vehicleId: null, trailerId: null, plannedStartAt: start, plannedEndAt: new Date('2026-10-10T16:00:00Z'), etaAt: null };
    const { service, repo } = buildService(trip);
    repo.withDriverScheduleLock.mockRejectedValueOnce(gone());
    repo.findById.mockResolvedValueOnce(trip).mockResolvedValueOnce({ ...trip, status: 'IN_PROGRESS' });
    await expect(service.assign('trp_1', { driverId: DRV, notify: false })).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });
});

describe('TripsService — edited window moves the endpoint stops (FE-15)', () => {
  const base = { id: 'trp_1', status: 'PLANNED', driverId: null, vehicleId: null, trailerId: null, etaAt: null, plannedStartAt: new Date('2026-10-20T08:00:00Z'), plannedEndAt: new Date('2026-10-21T08:00:00Z') };

  it('passes the new planned start / end as the pickup / delivery stop times', async () => {
    const { service, repo } = buildService(base);
    const pickupAt = new Date('2026-10-22T08:00:00Z');
    const deliveryAt = new Date('2026-10-23T08:00:00Z');
    await service.update('trp_1', { plannedStartAt: pickupAt, plannedEndAt: deliveryAt });
    expect((repo.update.mock.calls[0] as unknown[])[3]).toEqual({ pickupAt, deliveryAt });
  });

  it('moves only the pickup when only the start changes, inside the schedule-lock transaction', async () => {
    const { service, repo } = buildService({ ...base, vehicleId: 'veh_1' });
    const pickupAt = new Date('2026-10-20T10:00:00Z');
    await service.update('trp_1', { plannedStartAt: pickupAt });
    const [, , db, stopTimes] = repo.update.mock.calls[0] as unknown[];
    expect(db).toBe('tx');
    expect(stopTimes).toEqual({ pickupAt, deliveryAt: undefined });
  });

  it('does not touch stops when the window is not edited', async () => {
    const { service, repo } = buildService(base);
    await service.update('trp_1', { notes: 'x' });
    expect((repo.update.mock.calls[0] as unknown[])[3]).toBeUndefined();
  });
});
