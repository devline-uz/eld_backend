import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileTripService } from './mobile-trip.service';

function build() {
  const repo = {
    findActiveTrip: jest.fn(),
    findNextAssignedTrip: jest.fn(),
    findNonCompletedTrips: jest.fn().mockResolvedValue([]),
    findTrailerByNumber: jest.fn(),
    findTrailersByNumbers: jest.fn(),
    findTrailerById: jest.fn(),
    listActiveTrailers: jest.fn(),
    updateTrip: jest.fn(),
  };
  const service = new MobileTripService(repo as unknown as MobileFleetOpsRepository);
  return { service, repo };
}

const TRIP = {
  id: 'trip_1',
  number: 'T-1',
  status: 'IN_PROGRESS',
  vehicleId: 'veh_1',
  trailerId: null,
  shippingDocument: null,
  shippingDocuments: [],
  trailerNumbers: [],
  bobtail: false,
  commodity: null,
  weightLbs: null,
  pieces: null,
  plannedStartAt: null,
  plannedEndAt: null,
  startedAt: null,
  completedAt: null,
  etaAt: null,
  onTime: null,
  notes: null,
  stops: [],
};

describe('MobileTripService (MB-5)', () => {
  it('returns null when there is no IN_PROGRESS or ASSIGNED trip', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(null);
    repo.findNextAssignedTrip.mockResolvedValue(null);
    expect(await service.getActive('drv_1')).toBeNull();
  });

  it('prefers the IN_PROGRESS trip over the next ASSIGNED one', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    const result = await service.getActive('drv_1');
    expect(repo.findNextAssignedTrip).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'trip_1', documents: [] });
  });

  it('falls back to the next ASSIGNED trip when none is IN_PROGRESS', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(null);
    repo.findNextAssignedTrip.mockResolvedValue({ ...TRIP, status: 'ASSIGNED' });
    const result = await service.getActive('drv_1');
    expect(result).toMatchObject({ status: 'ASSIGNED' });
  });

  it('includes documents for every non-completed trip', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    repo.findNonCompletedTrips.mockResolvedValue([
      { id: 'trip_2', number: 'T-2', shippingDocument: 'BOL-2', commodity: 'Steel', pieces: 4, weightLbs: 1200 },
    ]);
    const result = await service.getActive('drv_1');
    expect(result?.documents).toEqual([{ tripId: 'trip_2', number: 'T-2', shippingDocument: 'BOL-2', commodity: 'Steel', pieces: 4, weightLbs: 1200 }]);
  });

  it('404s TRIP_NOT_FOUND on patch when there is no active trip', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(null);
    repo.findNextAssignedTrip.mockResolvedValue(null);
    await expect(service.patch('drv_1', { notes: 'x' })).rejects.toMatchObject({ code: 'TRIP_NOT_FOUND', status: 404 });
  });

  it('422s TRAILER_NOT_FOUND when trailerNumber does not resolve to a Trailer', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    repo.findTrailersByNumbers.mockResolvedValue([]);
    await expect(service.patch('drv_1', { trailerNumber: 'TR-999' })).rejects.toMatchObject({ code: 'TRAILER_NOT_FOUND', status: 422 });
    expect(repo.updateTrip).not.toHaveBeenCalled();
  });

  it('resolves trailerNumber to an existing Trailer id before updating', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    repo.findTrailersByNumbers.mockResolvedValue([{ id: 'trl_1', number: 'TR-1' }]);
    repo.updateTrip.mockResolvedValue({ ...TRIP, trailerId: 'trl_1', trailerNumbers: ['TR-1'], shippingDocument: 'BOL-9', shippingDocuments: ['BOL-9'] });

    const res = await service.patch('drv_1', { trailerNumber: 'TR-1', shippingDocument: 'BOL-9', notes: 'ok' });

    expect(repo.updateTrip).toHaveBeenCalledWith('trip_1', {
      shippingDocuments: ['BOL-9'],
      shippingDocument: 'BOL-9',
      trailerNumbers: ['TR-1'],
      trailerId: 'trl_1',
      bobtail: false,
      notes: 'ok',
    });
    expect(res).toMatchObject({ trailerNumber: 'TR-1', trailerNumbers: ['TR-1'], shippingDocuments: ['BOL-9'], bobtail: false });
  });

  it('MR-4: null / "" clear shippingDocument and trailer (and notes)', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    repo.updateTrip.mockResolvedValue(TRIP);
    await service.patch('drv_1', { shippingDocument: null, trailerNumber: null, notes: null });
    expect(repo.updateTrip).toHaveBeenCalledWith('trip_1', {
      shippingDocuments: [],
      shippingDocument: null,
      trailerNumbers: [],
      trailerId: null,
      bobtail: false,
      notes: null,
    });
    expect(repo.findTrailersByNumbers).not.toHaveBeenCalled();
  });

  it.each([[{ trailerNumber: 'bobtail' }], [{ bobtail: true }], [{ trailerNumbers: ['BOBTAIL'] }]])('MR-4: %j = bobtail, no trailer lookup', async (dto) => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    repo.updateTrip.mockResolvedValue({ ...TRIP, bobtail: true });
    const res = await service.patch('drv_1', dto);
    expect(repo.updateTrip).toHaveBeenCalledWith('trip_1', { trailerNumbers: [], trailerId: null, bobtail: true });
    expect(repo.findTrailersByNumbers).not.toHaveBeenCalled();
    expect(res).toMatchObject({ bobtail: true, trailerNumber: null });
  });

  it('MR-4: bobtail together with a real trailer is 422', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    await expect(service.patch('drv_1', { bobtail: true, trailerNumbers: ['TR-1'] })).rejects.toMatchObject({ status: 422 });
  });

  it('MR-4: arrays win over the single fields; first element mirrors the single column; one trailer query', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    repo.findTrailersByNumbers.mockResolvedValue([{ id: 'a', number: 'TR-1' }, { id: 'b', number: 'TR-2' }]);
    repo.updateTrip.mockResolvedValue(TRIP);
    await service.patch('drv_1', { shippingDocument: 'X', shippingDocuments: ['B1', 'B2'], trailerNumbers: ['TR-1', 'TR-2'] });
    expect(repo.findTrailersByNumbers).toHaveBeenCalledTimes(1);
    expect(repo.updateTrip).toHaveBeenCalledWith('trip_1', {
      shippingDocuments: ['B1', 'B2'],
      shippingDocument: 'B1',
      trailerNumbers: ['TR-1', 'TR-2'],
      trailerId: 'a',
      bobtail: false,
    });
  });

  it('GET falls back to the legacy single columns for pre-MR-4 rows', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue({ ...TRIP, shippingDocument: 'OLD', trailerId: 'trl_1' });
    repo.findTrailerById.mockResolvedValue({ id: 'trl_1', number: 'TR-7' });
    expect(await service.getActive('drv_1')).toMatchObject({ shippingDocuments: ['OLD'], trailerNumbers: ['TR-7'], trailerNumber: 'TR-7' });
  });

  it('MR-8: listTrailers maps rows to {id, number, plate}', async () => {
    const { service, repo } = build();
    repo.listActiveTrailers.mockResolvedValue([{ id: 't1', number: 'TR-1' }]);
    expect(await service.listTrailers('tr')).toEqual([{ id: 't1', number: 'TR-1', plate: null }]);
    expect(repo.listActiveTrailers).toHaveBeenCalledWith('tr', 50);
  });
});
