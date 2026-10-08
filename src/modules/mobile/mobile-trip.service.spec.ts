import type { AuditRepository } from '../audit/audit.repository';
import { TripPatchDto } from './dto/mobile-fleet-ops.dto';
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
    findDriverTimezone: jest.fn().mockResolvedValue({ homeTerminalTimezone: 'America/Chicago' }),
    findDayDetails: jest.fn().mockResolvedValue(null),
    upsertDayDetails: jest.fn(),
    dropCertification: jest.fn().mockResolvedValue(0),
  };
  const audit = { insert: jest.fn().mockResolvedValue({}) };
  const service = new MobileTripService(repo as unknown as MobileFleetOpsRepository, audit as unknown as AuditRepository);
  return { service, repo, audit };
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
  it('D-129: with no IN_PROGRESS or ASSIGNED trip GET returns the (empty) day details, never null', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(null);
    repo.findNextAssignedTrip.mockResolvedValue(null);
    const res = await service.getActive('drv_1', '2026-10-07');
    expect(res).toMatchObject({ source: 'DAY_DETAILS', id: null, trip: null, logDate: '2026-10-07', shippingDocuments: [], trailerNumbers: [], bobtail: false });
    expect(repo.findDayDetails).toHaveBeenCalledWith('drv_1', new Date('2026-10-07T00:00:00.000Z'));
  });

  it('D-129: GET with no trip returns the stored day details', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(null);
    repo.findNextAssignedTrip.mockResolvedValue(null);
    repo.findDayDetails.mockResolvedValue({ id: 'dd_1', shippingDocuments: ['BOL-1'], trailerNumbers: ['X1', 'X2'], trailerId: 't1', bobtail: false, notes: 'n', updatedAt: new Date() });
    expect(await service.getActive('drv_1', '2026-10-07')).toMatchObject({
      source: 'DAY_DETAILS',
      shippingDocument: 'BOL-1',
      trailerNumber: 'X1',
      trailerNumbers: ['X1', 'X2'],
      trailerId: 't1',
      notes: 'n',
    });
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

  it('D-129: PATCH with no active trip writes the day details instead of 404', async () => {
    const { service, repo, audit } = build();
    repo.findActiveTrip.mockResolvedValue(null);
    repo.findNextAssignedTrip.mockResolvedValue(null);
    repo.findTrailersByNumbers.mockResolvedValue([{ id: 'trl_9', number: 'T-5002' }]);
    repo.upsertDayDetails.mockImplementation(async (_d: string, _l: Date, data: Record<string, unknown>) => ({
      id: 'dd_1',
      shippingDocuments: [],
      trailerNumbers: [],
      trailerId: null,
      bobtail: false,
      notes: null,
      updatedAt: new Date(),
      ...data,
    }));
    repo.dropCertification.mockResolvedValue(1);

    const res = await service.patch('drv_1', { trailerNumbers: ['FREE-1', 't-5002'], shippingDocuments: ['BOL-7'] });

    const [, logDate, data] = repo.upsertDayDetails.mock.calls[0] as [string, Date, Record<string, unknown>];
    expect(logDate).toBeInstanceOf(Date);
    expect(data).toEqual({ shippingDocuments: ['BOL-7'], trailerNumbers: ['FREE-1', 'T-5002'], trailerId: 'trl_9', bobtail: false });
    expect(repo.updateTrip).not.toHaveBeenCalled();
    expect(res).toMatchObject({ source: 'DAY_DETAILS', id: null, trailerNumbers: ['FREE-1', 'T-5002'], trailerNumber: 'FREE-1', trailerId: 'trl_9' });
    // A header change on a certified day drops the certification and is audited.
    expect(repo.dropCertification).toHaveBeenCalledTimes(1);
    expect(audit.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DRIVER_DAY_DETAILS_UPDATED' }),
    );
    expect((audit.insert.mock.calls[0] as [{ after: { certificationDropped: boolean } }])[0].after.certificationDropped).toBe(true);
  });

  it('D-129: an unchanged day-details PATCH does not drop the certification', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(null);
    repo.findNextAssignedTrip.mockResolvedValue(null);
    const row = { id: 'dd_1', shippingDocuments: [], trailerNumbers: [], trailerId: null, bobtail: true, notes: null, updatedAt: new Date() };
    repo.findDayDetails.mockResolvedValue(row);
    repo.upsertDayDetails.mockResolvedValue(row);
    await service.patch('drv_1', { bobtail: true });
    expect(repo.dropCertification).not.toHaveBeenCalled();
  });

  it.each(['2999-01-01', '2000-01-01'])('D-129: logDate %s outside today..-30 days is 422', async (logDate) => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(null);
    repo.findNextAssignedTrip.mockResolvedValue(null);
    await expect(service.patch('drv_1', { notes: 'x', logDate })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(repo.upsertDayDetails).not.toHaveBeenCalled();
  });

  it('D-129: a trailer number not in the carrier list is accepted as free text (no TRAILER_NOT_FOUND)', async () => {
    const { service, repo } = build();
    repo.findActiveTrip.mockResolvedValue(TRIP);
    repo.findTrailersByNumbers.mockResolvedValue([]);
    repo.updateTrip.mockResolvedValue({ ...TRIP, trailerNumbers: ['TR-999'] });
    const res = await service.patch('drv_1', { trailerNumber: 'TR-999' });
    expect(repo.updateTrip).toHaveBeenCalledWith('trip_1', { trailerNumbers: ['TR-999'], trailerId: null, bobtail: false });
    expect(res).toMatchObject({ source: 'TRIP', trailerNumber: 'TR-999', trailerId: null });
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

describe('TripPatchDto (D-129 / Appendix A 7.42, 7.39)', () => {
  it('trims and upper-cases trailer numbers', () => {
    expect(TripPatchDto.parse({ trailerNumbers: [' x53-1188 ', 'ab12'] }).trailerNumbers).toEqual(['X53-1188', 'AB12']);
    expect(TripPatchDto.parse({ trailerNumber: ' bobtail ' }).trailerNumber).toBe('BOBTAIL');
  });

  it.each([['TRAILER-0001'], ['AB 12'], ['AB_12'], ['']])('rejects the trailer number %j', (value) => {
    expect(TripPatchDto.safeParse({ trailerNumbers: [value] }).success).toBe(false);
  });

  it('rejects a trailer list longer than 32 chars joined by spaces', () => {
    expect(TripPatchDto.safeParse({ trailerNumbers: ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC'] }).success).toBe(true);
    expect(TripPatchDto.safeParse({ trailerNumbers: ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC', 'D'] }).success).toBe(false);
  });

  it('caps a shipping document at 40 chars and needs a field besides logDate', () => {
    expect(TripPatchDto.safeParse({ shippingDocument: 'B'.repeat(40) }).success).toBe(true);
    expect(TripPatchDto.safeParse({ shippingDocument: 'B'.repeat(41) }).success).toBe(false);
    expect(TripPatchDto.safeParse({ logDate: '2026-10-08' }).success).toBe(false);
    expect(TripPatchDto.safeParse({ logDate: '10/08/2026', notes: 'x' }).success).toBe(false);
  });
});
