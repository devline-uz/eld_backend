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
    await expect(service.assign('trp_1', { driverId: 'drv_1' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('assigns a PLANNED trip and raises alert.trip_assigned', async () => {
    const { service, alertQueue } = buildService({ id: 'trp_1', status: 'PLANNED', etaAt: null });
    const result = await service.assign('trp_1', { driverId: 'drv_1' });
    expect(result.status).toBe('ASSIGNED');
    expect(alertQueue.add).toHaveBeenCalledWith('alert.trip_assigned', { tripId: 'trp_1', driverId: 'drv_1' });
  });
});
