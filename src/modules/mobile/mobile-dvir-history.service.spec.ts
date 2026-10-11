import { MobileDvirHistoryService } from './mobile-dvir-history.service';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import type { StoragePort } from '../../core/storage/storage.port';

function build() {
  const repo = { listOwnDvirs: jest.fn(), getOwnDvir: jest.fn(), getOwnDvirForPdf: jest.fn() };
  const pdfBuilder = { build: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')) };
  const storage = { presignGet: jest.fn().mockResolvedValue('https://signed') };
  const service = new MobileDvirHistoryService(repo as unknown as MobileFleetOpsRepository, storage as unknown as StoragePort, pdfBuilder as never);
  return { service, repo, storage, pdfBuilder };
}

const DVIR = {
  id: 'dvir_1',
  driverId: 'drv_1',
  vehicleId: 'veh_1',
  trailerId: null,
  type: 'PRE_TRIP',
  submittedAt: new Date('2026-09-10'),
  odometerMi: 100,
  latitude: null,
  longitude: null,
  locationName: null,
  vehicleCondition: 'DEFECTS_FOUND',
  notes: null,
  repairStatus: 'PENDING',
  driverSignatureUrl: 'signatures/x.png',
  driverSignatureHash: 'abc',
  mechanicName: null,
  mechanicSignedAt: null,
  mechanicNote: null,
  nextDriverReviewedAt: null,
  defects: [{ id: 'def_1', part: 'TRUCK', category: 'brakes', severity: 'CRITICAL', description: 'x', status: 'OPEN', outOfService: true, resolvedAt: null, resolutionNote: null, photos: [] }],
  photos: [],
};

describe('MobileDvirHistoryService (MB-10)', () => {
  it('list() summarizes defect count, condition and repair status', async () => {
    const { service, repo } = build();
    repo.listOwnDvirs.mockResolvedValue([{ ...DVIR, _count: { defects: 1 }, trailer: { number: 'T-77' } }]);
    const result = await service.list('drv_1', 14);
    expect(result).toEqual([
      { id: 'dvir_1', vehicleId: 'veh_1', type: 'PRE_TRIP', submittedAt: DVIR.submittedAt, vehicleCondition: 'DEFECTS_FOUND', defectCount: 1, repairStatus: 'PENDING', trailerNumber: 'T-77', odometerMi: 100, location: null },
    ]);
  });

  it('MR-14 list() rows carry trailerNumber=null and odometerMi=null when the DVIR has neither', async () => {
    const { service, repo } = build();
    repo.listOwnDvirs.mockResolvedValue([{ ...DVIR, odometerMi: null, _count: { defects: 0 }, trailer: null }]);
    const [row] = await service.list('drv_1', 14);
    expect(row).toMatchObject({ trailerNumber: null, odometerMi: null });
  });

  it('MB-15 list() rows carry location (lat/lon/name), and null when nothing was captured', async () => {
    const { service, repo } = build();
    repo.listOwnDvirs.mockResolvedValue([
      { ...DVIR, latitude: 41.75, longitude: -87.98, locationName: 'Darien yard', _count: { defects: 0 }, trailer: null },
      { ...DVIR, latitude: null, longitude: null, locationName: null, _count: { defects: 0 }, trailer: null },
    ]);
    const [withLoc, without] = await service.list('drv_1', 14);
    expect(withLoc.location).toMatchObject({ lat: 41.75, lon: -87.98 });
    expect(withLoc.location?.name).toEqual(expect.any(String));
    expect(without.location).toBeNull();
  });

  it('MR-14 get() returns location (numbers; name-only too) and trailerNumber; MR-10 mechanic signature url', async () => {
    const { service, repo, storage } = build();
    repo.getOwnDvir.mockResolvedValue({
      ...DVIR,
      latitude: '39.961200',
      longitude: '-82.998800',
      locationName: 'Columbus, OH',
      trailer: { number: 'T-77' },
      mechanicName: 'Bob',
      mechanicSignedAt: new Date('2026-09-10'),
      mechanicSignatureUrl: 'signatures/drv_1/m.png',
      mechanicSignatureHash: 'mm',
    });
    const full = await service.get('dvir_1', 'drv_1');
    expect(full.location).toEqual({ lat: 39.9612, lon: -82.9988, name: 'Columbus, OH' });
    expect(full.trailerNumber).toBe('T-77');
    expect(full.mechanicSignature).toMatchObject({ name: 'Bob', key: 'signatures/drv_1/m.png', url: 'https://signed', hash: 'mm' });
    expect(storage.presignGet).toHaveBeenCalledWith('signatures/drv_1/m.png', expect.any(Number));

    repo.getOwnDvir.mockResolvedValue({ ...DVIR, locationName: 'Yard 3', trailer: null });
    expect((await service.get('dvir_1', 'drv_1')).location).toEqual({ lat: null, lon: null, name: 'Yard 3' });
  });

  it('list() applies the days window', async () => {
    const { service, repo } = build();
    repo.listOwnDvirs.mockResolvedValue([]);
    await service.list('drv_1', 14);
    const [driverId, since] = repo.listOwnDvirs.mock.calls[0] as [string, Date];
    expect(driverId).toBe('drv_1');
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(14 * 24 * 60 * 60 * 1000 - 1000);
  });

  it('get() 404s DVIR_NOT_FOUND when it is not this driver\'s own DVIR', async () => {
    const { service, repo } = build();
    repo.getOwnDvir.mockResolvedValue(null);
    await expect(service.get('dvir_9', 'drv_1')).rejects.toMatchObject({ code: 'DVIR_NOT_FOUND', status: 404 });
  });

  it('get() returns full detail with presigned signature/photo URLs', async () => {
    const { service, repo, storage } = build();
    repo.getOwnDvir.mockResolvedValue(DVIR);
    const result = await service.get('dvir_1', 'drv_1');
    expect(storage.presignGet).toHaveBeenCalledWith('signatures/x.png', expect.any(Number));
    expect(result.driverSignature).toEqual({ key: 'signatures/x.png', url: 'https://signed', hash: 'abc' });
    expect(result.defects).toHaveLength(1);
    expect(result.mechanicSignature).toBeNull();
  });

  it('pdf() renders the owned DVIR through the shared DvirPdfBuilder (MB-4)', async () => {
    const { service, repo, pdfBuilder } = build();
    repo.getOwnDvirForPdf.mockResolvedValue(DVIR);
    const out = await service.pdf('dvir_1', 'drv_1');
    expect(repo.getOwnDvirForPdf).toHaveBeenCalledWith('dvir_1', 'drv_1');
    expect(pdfBuilder.build).toHaveBeenCalledWith(DVIR);
    expect(out.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('pdf() 404s DVIR_NOT_FOUND rather than leaking another driver\'s DVIR existence', async () => {
    const { service, repo, pdfBuilder } = build();
    repo.getOwnDvirForPdf.mockResolvedValue(null);
    await expect(service.pdf('dvir_9', 'drv_1')).rejects.toMatchObject({ code: 'DVIR_NOT_FOUND', status: 404 });
    expect(pdfBuilder.build).not.toHaveBeenCalled();
  });
});
