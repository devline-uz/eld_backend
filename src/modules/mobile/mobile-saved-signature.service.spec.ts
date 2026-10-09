import { MobileSavedSignatureService } from './mobile-saved-signature.service';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

function build() {
  const row = (key: string) => ({ driverId: 'drv_1', key, sha256: 'ff', mimeType: 'image/png', sizeBytes: 10, createdAt: new Date(), updatedAt: new Date('2026-10-08T12:00:00Z') });
  const repo = {
    getSavedSignature: jest.fn().mockResolvedValue(null),
    upsertSavedSignature: jest.fn().mockImplementation((_d: string, data: { key: string }) => Promise.resolve(row(data.key))),
    deleteSavedSignature: jest.fn().mockResolvedValue(null),
  };
  const mobileRepo = { findSyncedByClientId: jest.fn().mockResolvedValue(null), recordSyncedResult: jest.fn().mockResolvedValue({ status: 'ACCEPTED', errorCode: null }) };
  const signatures = { store: jest.fn().mockResolvedValue({ id: 'sig_1', key: 'signatures/drv_1/sig_1.png', sha256: 'ff', sizeBytes: 10 }) };
  const storage = { presignGet: jest.fn().mockResolvedValue('https://signed'), exists: jest.fn().mockResolvedValue(false), get: jest.fn() };
  const service = new MobileSavedSignatureService(repo as never, mobileRepo as never, signatures as never, storage as never);
  return { service, repo, mobileRepo, signatures, storage, row };
}

describe('MobileSavedSignatureService (MR-27)', () => {
  it('get() returns null when nothing is saved', async () => {
    const { service } = build();
    await expect(service.get('drv_1')).resolves.toBeNull();
  });

  it('get() returns the id derived from the key and a presigned url', async () => {
    const { service, repo, row } = build();
    repo.getSavedSignature.mockResolvedValue(row('signatures/drv_1/abc-1.png'));
    await expect(service.get('drv_1')).resolves.toMatchObject({ signatureImageId: 'abc-1', url: 'https://signed', mimeType: 'image/png' });
  });

  it('put(base64) stores bytes through SignatureService (size/mime rules) and upserts the row', async () => {
    const { service, signatures, repo } = build();
    const out = await service.put('drv_1', { signatureBase64: PNG, mimeType: 'image/png' });
    expect(signatures.store).toHaveBeenCalledWith('signatures', 'drv_1', PNG, 'image/png');
    expect(repo.upsertSavedSignature).toHaveBeenCalledWith('drv_1', { key: 'signatures/drv_1/sig_1.png', sha256: 'ff', mimeType: 'image/png', sizeBytes: 10 });
    expect(out.signatureImageId).toBe('sig_1');
  });

  it('put(signatureImageId) adopts an existing object of this driver, trying png then jpg', async () => {
    const { service, storage, repo, signatures } = build();
    storage.exists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    storage.get.mockResolvedValue(Buffer.from('jpegbytes'));
    await service.put('drv_1', { signatureImageId: 'sig_9' });
    expect(storage.exists).toHaveBeenNthCalledWith(1, 'signatures/drv_1/sig_9.png');
    expect(storage.exists).toHaveBeenNthCalledWith(2, 'signatures/drv_1/sig_9.jpg');
    expect(repo.upsertSavedSignature).toHaveBeenCalledWith('drv_1', expect.objectContaining({ key: 'signatures/drv_1/sig_9.jpg', mimeType: 'image/jpeg', sizeBytes: 9 }));
    expect(signatures.store).not.toHaveBeenCalled();
  });

  it('put(signatureImageId) of an unknown id is a 422 and saves nothing', async () => {
    const { service, repo } = build();
    await expect(service.put('drv_1', { signatureImageId: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(repo.upsertSavedSignature).not.toHaveBeenCalled();
  });

  it('clientId: replay returns the first result without storing again; a clientId spent elsewhere is a 409', async () => {
    const { service, mobileRepo, signatures } = build();
    await service.put('drv_1', { signatureBase64: PNG, clientId: 'client-0001-aaaa' });
    expect(mobileRepo.recordSyncedResult).toHaveBeenCalledWith('drv_1', 'client-0001-aaaa', 'saved_signature', expect.any(Date), 'ACCEPTED', null, expect.objectContaining({ key: 'signatures/drv_1/sig_1.png' }));

    signatures.store.mockClear();
    mobileRepo.findSyncedByClientId.mockResolvedValueOnce({ type: 'saved_signature', status: 'ACCEPTED', result: { signatureImageId: 'sig_1', key: 'signatures/drv_1/sig_1.png', mimeType: 'image/png', sizeBytes: 10, sha256: 'ff', updatedAt: '2026-10-08T12:00:00.000Z' } });
    await expect(service.put('drv_1', { signatureBase64: PNG, clientId: 'client-0001-aaaa' })).resolves.toMatchObject({ signatureImageId: 'sig_1', url: 'https://signed' });
    expect(signatures.store).not.toHaveBeenCalled();

    mobileRepo.findSyncedByClientId.mockResolvedValueOnce({ type: 'sync_dvir', status: 'ACCEPTED', result: {} });
    await expect(service.put('drv_1', { signatureBase64: PNG, clientId: 'client-0001-aaaa' })).rejects.toMatchObject({ status: 409 });
  });

  it('remove() is idempotent', async () => {
    const { service, repo, row } = build();
    await expect(service.remove('drv_1')).resolves.toEqual({ deleted: false });
    repo.deleteSavedSignature.mockResolvedValue(row('signatures/drv_1/a.png'));
    await expect(service.remove('drv_1')).resolves.toEqual({ deleted: true });
  });
});
