import type { ContextUser } from '../../core/context/request-context';
import { MobileDvirService } from './mobile-dvir.service';
import type { DvirCreateInput } from './mobile.repository';

const DRIVER: ContextUser = { id: 'drv_1', type: 'driver' };
const PHOTO_A = '11111111-1111-4111-8111-111111111111';
const PHOTO_B = '22222222-2222-4222-8222-222222222222';

function build() {
  const repo = {
    findVehicle: jest.fn().mockResolvedValue({ id: 'veh_1' }),
    findTrailer: jest.fn().mockResolvedValue({ id: 'trl_1', deletedAt: null }),
    createDvir: jest.fn().mockResolvedValue({ id: 'dvir_1', defects: [] }),
    markVehicleOutOfService: jest.fn().mockResolvedValue({}),
    findSyncedByClientId: jest.fn().mockResolvedValue(null),
    recordSyncedResult: jest.fn().mockResolvedValue({ status: 'ACCEPTED', errorCode: null }),
  };
  const photos = {
    createPhoto: jest.fn().mockResolvedValue({}),
    findLinkable: jest.fn().mockResolvedValue([{ id: PHOTO_A }, { id: PHOTO_B }]),
  };
  const signatures = { store: jest.fn().mockResolvedValue({ id: 'sig_1', key: 'signatures/drv_1/sig_1.png', sha256: 'ff', sizeBytes: 10 }) };
  const audit = { insert: jest.fn().mockResolvedValue({}) };
  const events = { publish: jest.fn().mockResolvedValue(undefined) };
  const alertQueue = { add: jest.fn().mockResolvedValue({}) };
  const catalog = { listCatalogLabels: jest.fn().mockResolvedValue([{ part: 'TRUCK', code: 'BRAKES_SERVICE', name: 'Brakes, Service' }]) };
  const service = new MobileDvirService(repo as never, photos as never, signatures as never, audit as never, events as never, alertQueue as never, catalog as never);
  return { service, repo, photos, signatures, audit, catalog };
}

function dto(defects: Array<{ photoAttachmentIds: string[] }>) {
  return {
    vehicleId: 'veh_1',
    type: 'PRE_TRIP' as const,
    submittedAt: new Date('2026-09-10T12:00:00Z'),
    odometerMi: 993107,
    vehicleCondition: 'DEFECTS_FOUND' as const,
    defects: defects.map((d, i) => ({ part: 'TRUCK' as const, category: 'Brakes', severity: 'MAJOR' as const, description: `defect ${i}`, ...d })),
    signatureBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    signatureMimeType: 'image/png' as const,
  };
}

describe('MobileDvirService — MB-6 DVIR photo persistence (regression)', () => {
  it('uploadSignature(DVIR_PHOTO) writes an Attachment row with the returned id; signatures stay key-only', async () => {
    const { service, photos, signatures } = build();
    signatures.store.mockResolvedValueOnce({ id: PHOTO_A, key: `dvir-photos/drv_1/${PHOTO_A}.jpg`, sha256: 'aa', sizeBytes: 123 });
    const out = await service.uploadSignature('drv_1', { purpose: 'DVIR_PHOTO', base64: 'AAAAAAAAAAAAAAAAAAAA', mimeType: 'image/jpeg' });
    expect(photos.createPhoto).toHaveBeenCalledWith({ id: PHOTO_A, key: `dvir-photos/drv_1/${PHOTO_A}.jpg`, mimeType: 'image/jpeg', sizeBytes: 123, sha256: 'aa', driverId: 'drv_1' });
    expect(out).toMatchObject({ signatureImageId: PHOTO_A, attachmentId: PHOTO_A });

    photos.createPhoto.mockClear();
    const sig = await service.uploadSignature('drv_1', { purpose: 'CERTIFICATION', base64: 'AAAAAAAAAAAAAAAAAAAA', mimeType: 'image/png' });
    expect(photos.createPhoto).not.toHaveBeenCalled();
    expect(sig.attachmentId).toBeNull();
  });

  it('submit passes photoAttachmentIds through to repo.createDvir per defect (the bug: they were dropped)', async () => {
    const { service, repo, photos } = build();
    await service.submit('drv_1', dto([{ photoAttachmentIds: [PHOTO_A] }, { photoAttachmentIds: [PHOTO_B] }]), DRIVER);
    expect(photos.findLinkable).toHaveBeenCalledWith([PHOTO_A, PHOTO_B], 'drv_1');
    const [input] = repo.createDvir.mock.calls[0] as [DvirCreateInput];
    expect(input.defects[0].photoAttachmentIds).toEqual([PHOTO_A]);
    expect(input.defects[1].photoAttachmentIds).toEqual([PHOTO_B]);
  });

  it('submit reports photoCount and audits it', async () => {
    const { service, audit } = build();
    const out = await service.submit('drv_1', dto([{ photoAttachmentIds: [PHOTO_A, PHOTO_B] }]), DRIVER);
    expect(out).toMatchObject({ id: 'dvir_1', defectCount: 1, photoCount: 2, applied: true });
    const [auditRow] = audit.insert.mock.calls[0] as [{ action: string; after: { photoCount: number } }];
    expect(auditRow.action).toBe('DVIR_SUBMITTED');
    expect(auditRow.after.photoCount).toBe(2);
  });

  it("submit rejects with 422 VALIDATION_FAILED when a photo id is unknown, another driver's, or already attached — before storing the signature", async () => {
    const { service, repo, photos, signatures } = build();
    photos.findLinkable.mockResolvedValueOnce([{ id: PHOTO_A }]);
    await expect(service.submit('drv_1', dto([{ photoAttachmentIds: [PHOTO_A, PHOTO_B] }]), DRIVER)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      details: { missing: [PHOTO_B] },
    });
    expect(signatures.store).not.toHaveBeenCalled();
    expect(repo.createDvir).not.toHaveBeenCalled();
  });

  it('submit without photos never queries attachments', async () => {
    const { service, photos, repo } = build();
    await service.submit('drv_1', dto([{ photoAttachmentIds: [] }]), DRIVER);
    expect(photos.findLinkable).not.toHaveBeenCalled();
    const [input] = repo.createDvir.mock.calls[0] as [DvirCreateInput];
    expect(input.defects[0].photoAttachmentIds).toEqual([]);
  });
});

describe('MobileDvirService — trailerId must name a live trailer (soft-deleted trailers)', () => {
  const TRL = '44444444-4444-4444-8444-444444444444';
  const base = () => ({ ...dto([]), vehicleCondition: 'SATISFACTORY' as const, trailerId: TRL });

  it('accepts a live trailer and stores its id', async () => {
    const { service, repo } = build();
    await service.submit('drv_1', base(), DRIVER);
    expect(repo.findTrailer).toHaveBeenCalledWith(TRL);
    expect((repo.createDvir.mock.calls[0] as [DvirCreateInput])[0].trailerId).toBe(TRL);
  });

  it('rejects a trailer deleted before the inspection with 422 TRAILER_NOT_FOUND, before storing the signature', async () => {
    const { service, repo, signatures } = build();
    repo.findTrailer.mockResolvedValueOnce({ id: TRL, deletedAt: new Date('2026-09-01T00:00:00Z') });
    await expect(service.submit('drv_1', base(), DRIVER)).rejects.toMatchObject({ code: 'TRAILER_NOT_FOUND', status: 422 });
    expect(signatures.store).not.toHaveBeenCalled();
    expect(repo.createDvir).not.toHaveBeenCalled();
  });

  it('accepts an offline DVIR performed before the trailer was deleted (historical record)', async () => {
    const { service, repo } = build();
    repo.findTrailer.mockResolvedValueOnce({ id: TRL, deletedAt: new Date('2026-09-20T00:00:00Z') });
    await service.submit('drv_1', base(), DRIVER);
    expect(repo.createDvir).toHaveBeenCalled();
  });

  it('rejects an unknown trailerId with 422 instead of an FK error', async () => {
    const { service, repo } = build();
    repo.findTrailer.mockResolvedValueOnce(null);
    await expect(service.submit('drv_1', base(), DRIVER)).rejects.toMatchObject({ code: 'TRAILER_NOT_FOUND', status: 422 });
  });
});

describe('MobileDvirService — MR-9/10/11 (catalog, mechanic signature, optional odometer, idempotency)', () => {
  const base = () => ({ ...dto([{ photoAttachmentIds: [] }]), vehicleCondition: 'SATISFACTORY' as const });
  const created = (repo: { createDvir: jest.Mock }) => (repo.createDvir.mock.calls[0] as [DvirCreateInput])[0];

  it('MR-9 accepts a category that is not in the catalog (lenient) and stores it as sent', async () => {
    const { service, repo, catalog } = build();
    await service.submit('drv_1', { ...base(), defects: [{ part: 'TRUCK', category: 'Totally new item', severity: 'MINOR', description: 'x', photoAttachmentIds: [] }] }, DRIVER);
    expect(catalog.listCatalogLabels).toHaveBeenCalledTimes(1);
    expect(created(repo).defects[0].category).toBe('Totally new item');
  });

  it('MR-9 a failing catalog lookup never blocks the DVIR', async () => {
    const { service, repo, catalog } = build();
    catalog.listCatalogLabels.mockRejectedValueOnce(new Error('db down'));
    await service.submit('drv_1', base(), DRIVER);
    expect(repo.createDvir).toHaveBeenCalled();
  });

  it('MR-10 stores the mechanic name + signature (key, sha256, signedAt) and reports its id', async () => {
    const { service, repo, signatures } = build();
    signatures.store
      .mockResolvedValueOnce({ id: 'sig_drv', key: 'signatures/drv_1/sig_drv.png', sha256: 'aa', sizeBytes: 10 })
      .mockResolvedValueOnce({ id: 'sig_mech', key: 'signatures/drv_1/sig_mech.jpg', sha256: 'bb', sizeBytes: 12 });
    const out = await service.submit('drv_1', { ...base(), mechanicName: ' Bob Mechanic ', mechanicSignatureBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', mechanicSignatureMimeType: 'image/jpeg' }, DRIVER);
    expect(signatures.store).toHaveBeenLastCalledWith('signatures', 'drv_1', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'image/jpeg');
    expect(created(repo)).toMatchObject({ mechanicName: 'Bob Mechanic', mechanicSignatureUrl: 'signatures/drv_1/sig_mech.jpg', mechanicSignatureHash: 'bb' });
    expect(created(repo).mechanicSignedAt).toBeInstanceOf(Date);
    expect(out).toMatchObject({ signatureImageId: 'sig_drv', mechanicSignatureImageId: 'sig_mech' });
  });

  it('MR-10 mechanic signature without a name is a 422 and nothing is stored', async () => {
    const { service, repo, signatures } = build();
    await expect(service.submit('drv_1', { ...base(), mechanicSignatureBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }, DRIVER)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(signatures.store).not.toHaveBeenCalled();
    expect(repo.createDvir).not.toHaveBeenCalled();
  });

  it('MR-10 mechanic name alone is stored without a signedAt/signature', async () => {
    const { service, repo } = build();
    await service.submit('drv_1', { ...base(), mechanicName: 'Bob' }, DRIVER);
    expect(created(repo)).toMatchObject({ mechanicName: 'Bob', mechanicSignedAt: null, mechanicSignatureUrl: null });
  });

  it('MR-11 odometerMi omitted: falls back to the vehicle odometer when known, null when never set', async () => {
    const { service, repo } = build();
    const { odometerMi: _omit, ...noOdo } = base();
    repo.findVehicle.mockResolvedValueOnce({ id: 'veh_1', odometerMi: 51234, deviceOdometerMi: 10, odometerCalibratedAt: new Date() });
    await service.submit('drv_1', noOdo, DRIVER);
    expect((repo.createDvir.mock.calls[0] as [DvirCreateInput])[0].odometerMi).toBe(51234);

    repo.createDvir.mockClear();
    repo.findVehicle.mockResolvedValueOnce({ id: 'veh_1', odometerMi: 0, deviceOdometerMi: null, odometerCalibratedAt: null });
    await service.submit('drv_1', { ...noOdo, odometerMi: null }, DRIVER);
    expect((repo.createDvir.mock.calls[0] as [DvirCreateInput])[0].odometerMi).toBeNull();
  });

  it('idempotency: a replayed clientId returns the first answer; another operation type is a 409', async () => {
    const { service, repo } = build();
    const CID = 'client-0001-aaaa';
    await service.submitIdempotent('drv_1', { ...base(), clientId: CID }, DRIVER);
    expect(repo.recordSyncedResult).toHaveBeenCalledWith('drv_1', CID, 'dvir_submit', expect.any(Date), 'ACCEPTED', null, expect.objectContaining({ id: 'dvir_1' }));

    repo.createDvir.mockClear();
    repo.findSyncedByClientId.mockResolvedValueOnce({ type: 'dvir_submit', status: 'ACCEPTED', result: { id: 'dvir_first', applied: true } });
    await expect(service.submitIdempotent('drv_1', { ...base(), clientId: CID }, DRIVER)).resolves.toEqual({ id: 'dvir_first', applied: true });
    expect(repo.createDvir).not.toHaveBeenCalled();

    repo.findSyncedByClientId.mockResolvedValueOnce({ type: 'release_vehicle', status: 'ACCEPTED', result: {} });
    await expect(service.submitIdempotent('drv_1', { ...base(), clientId: CID }, DRIVER)).rejects.toMatchObject({ status: 409 });
    expect(repo.createDvir).not.toHaveBeenCalled();
  });
});
