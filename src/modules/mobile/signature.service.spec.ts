import { MAX_INVOICE_PDF_BYTES, MAX_SIGNATURE_BYTES, SignatureService } from './signature.service';

function build() {
  const storage = { put: jest.fn().mockResolvedValue(undefined) };
  return { service: new SignatureService(storage as never), storage };
}
const pdf = (extra = 64) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(extra, 0x20)]);

describe('SignatureService — M-39 invoice PDFs', () => {
  it('stores a real PDF under invoices/<driver>/<id>.pdf with its content type and sha256', async () => {
    const { service, storage } = build();
    const out = await service.store('invoices', 'drv_1', pdf().toString('base64'), 'application/pdf');
    expect(out.key).toMatch(/^invoices\/drv_1\/[0-9a-f-]{36}\.pdf$/);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.put).toHaveBeenCalledWith(out.key, expect.any(Buffer), { contentType: 'application/pdf', contentLength: out.sizeBytes });
  });

  it('accepts a data: URL wrapper', async () => {
    const { service } = build();
    await expect(service.store('invoices', 'drv_1', `data:application/pdf;base64,${pdf().toString('base64')}`, 'application/pdf')).resolves.toMatchObject({ sizeBytes: 73 });
  });

  it('rejects bytes without the %PDF- header with 422 and stores nothing', async () => {
    const { service, storage } = build();
    await expect(service.store('invoices', 'drv_1', Buffer.from('<html>not a pdf at all</html>').toString('base64'), 'application/pdf')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('allows a PDF above 2 MiB up to 10 MiB, and rejects above 10 MiB with 413', async () => {
    const { service, storage } = build();
    await expect(service.store('invoices', 'drv_1', pdf(MAX_SIGNATURE_BYTES + 10).toString('base64'), 'application/pdf')).resolves.toBeDefined();
    storage.put.mockClear();
    await expect(service.store('invoices', 'drv_1', pdf(MAX_INVOICE_PDF_BYTES).toString('base64'), 'application/pdf')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', status: 413 });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('keeps the 2 MiB cap for images', async () => {
    const { service } = build();
    await expect(service.store('signatures', 'drv_1', Buffer.alloc(MAX_SIGNATURE_BYTES + 1, 1).toString('base64'), 'image/png')).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
});
