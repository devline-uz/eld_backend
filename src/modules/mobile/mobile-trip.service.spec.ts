import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileTripService } from './mobile-trip.service';

function build() {
  const repo = {
    findActiveTrip: jest.fn(),
    findNextAssignedTrip: jest.fn(),
    findNonCompletedTrips: jest.fn().mockResolvedValue([]),
    findTrailerByNumber: jest.fn(),
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
    repo.findTrailerByNumber.mockResolvedValue(null);
    await expect(service.patch('drv_1', { trailerNumber: 'TR-999' })).rejects.toMatchObject({ code: 'TRAILER_NOT_FOUND', status: 422 });
    expect(repo.updateTrip).not.toHaveBeenCalled();
  });

  it('resolves trailerNumber to an existing Trailer id before updating', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    repo.findTrailerByNumber.mockResolvedValue({ id: 'trl_1', number: 'TR-1' });
    repo.updateTrip.mockResolvedValue({ ...TRIP, trailerId: 'trl_1' });

    await service.patch('drv_1', { trailerNumber: 'TR-1', shippingDocument: 'BOL-9', notes: 'ok' });

    expect(repo.updateTrip).toHaveBeenCalledWith('trip_1', { shippingDocument: 'BOL-9', trailerId: 'trl_1', notes: 'ok' });
  });
});
