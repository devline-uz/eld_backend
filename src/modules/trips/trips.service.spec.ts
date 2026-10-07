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
  };
  const events = { publish: jest.fn(async () => undefined) };
  const alertQueue = { add: jest.fn(async () => undefined) };
  return { service: new TripsService(repo as never, events as never, alertQueue as never), repo, events, alertQueue };
}

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
