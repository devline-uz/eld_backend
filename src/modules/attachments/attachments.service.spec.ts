import type { ContextUser } from '../../core/context/request-context';
import { AttachmentsService } from './attachments.service';
import type { AttachmentOwnerRow } from './attachments.repository';

function buildService(row: AttachmentOwnerRow | null) {
  const repo = { findWithOwner: jest.fn(async () => row) };
  const storage = { presignGet: jest.fn(async (key: string) => `https://minio.internal/${key}?sig=abc`) };
  return { service: new AttachmentsService(repo as never, storage as never), repo, storage };
}

const dvirDriver = 'drv_1';
const notUploaded = { uploadedById: null, uploadedByType: 'USER' as const, maintenanceInvoiceFor: [] };
const dvirRow: AttachmentOwnerRow = {
  id: 'att_1',
  key: 'dvir/photo.jpg',
  ...notUploaded,
  dvirId: 'dvir_1',
  defectId: null,
  ticketId: null,
  dvir: { driverId: dvirDriver },
  defect: null,
  ticket: null,
};
const defectRow: AttachmentOwnerRow = {
  id: 'att_2',
  key: 'defect/photo.jpg',
  ...notUploaded,
  dvirId: null,
  defectId: 'defect_1',
  ticketId: null,
  dvir: null,
  defect: { dvir: { driverId: dvirDriver } },
  ticket: null,
};
const ticketRow: AttachmentOwnerRow = {
  id: 'att_3',
  key: 'ticket/diagnostics.json',
  ...notUploaded,
  dvirId: null,
  defectId: null,
  ticketId: 'tkt_1',
  dvir: null,
  defect: null,
  ticket: { createdByUserId: 'usr_owner', createdByDriverId: null },
};

describe('AttachmentsService.presignAttachment (TZ §20 B-41)', () => {
  it('404s when the attachment does not exist', async () => {
    const { service } = buildService(null);
    await expect(service.presignAttachment('missing', { id: 'usr_1', type: 'user', permissions: { dvir: 'FULL' } })).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_FOUND',
    });
  });

  it('lets the owning driver presign their own DVIR photo', async () => {
    const { service, storage } = buildService(dvirRow);
    const actor: ContextUser = { id: dvirDriver, type: 'driver' };
    const result = await service.presignAttachment('att_1', actor);
    expect(result.url).toContain('dvir/photo.jpg');
    expect(storage.presignGet).toHaveBeenCalledWith('dvir/photo.jpg', 15 * 60);
  });

  it('404s a different driver trying the same DVIR photo (IDOR)', async () => {
    const { service } = buildService(dvirRow);
    const actor: ContextUser = { id: 'drv_other', type: 'driver' };
    await expect(service.presignAttachment('att_1', actor)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });

  it('lets a back-office user with dvir READ+ presign a defect photo', async () => {
    const { service } = buildService(defectRow);
    const actor: ContextUser = { id: 'usr_1', type: 'user', permissions: { dvir: 'READ' } };
    const result = await service.presignAttachment('att_2', actor);
    expect(result.url).toContain('defect/photo.jpg');
  });

  it('404s a back-office user with no dvir permission', async () => {
    const { service } = buildService(defectRow);
    const actor: ContextUser = { id: 'usr_1', type: 'user', permissions: { dvir: 'NONE' } };
    await expect(service.presignAttachment('att_2', actor)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });

  it('lets the ticket author or a support-permitted user presign a ticket attachment', async () => {
    const { service } = buildService(ticketRow);
    const asOwner = await service.presignAttachment('att_3', { id: 'usr_owner', type: 'user' });
    expect(typeof asOwner.url).toBe('string');
    const asSupport = await service.presignAttachment('att_3', { id: 'usr_2', type: 'user', permissions: { support: 'READ' } });
    expect(typeof asSupport.url).toBe('string');
    await expect(
      service.presignAttachment('att_3', { id: 'usr_3', type: 'user', permissions: { support: 'NONE' } }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });

  it('returns an expiresAt roughly 15 minutes out', async () => {
    const { service } = buildService(dvirRow);
    const before = Date.now();
    const result = await service.presignAttachment('att_1', { id: dvirDriver, type: 'driver' });
    const expiresIn = new Date(result.expiresAt).getTime() - before;
    expect(expiresIn).toBeGreaterThan(14 * 60 * 1000);
    expect(expiresIn).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
  });
});

describe('AttachmentsService.presignAttachment — M-39/M-41 maintenance invoice PDFs', () => {
  const invoiceRow: AttachmentOwnerRow = {
    id: 'att_inv',
    key: 'invoices/drv_1/att_inv.pdf',
    dvirId: null,
    defectId: null,
    ticketId: null,
    uploadedById: 'drv_1',
    uploadedByType: 'DRIVER' as const,
    maintenanceInvoiceFor: [],
    dvir: null,
    defect: null,
    ticket: null,
  };

  it('lets the uploading driver presign their own invoice PDF', async () => {
    const { service, storage } = buildService(invoiceRow);
    const result = await service.presignAttachment('att_inv', { id: 'drv_1', type: 'driver' });
    expect(result.url).toContain('invoices/drv_1/att_inv.pdf');
    expect(storage.presignGet).toHaveBeenCalledWith('invoices/drv_1/att_inv.pdf', 15 * 60);
  });

  it("404s another driver on someone else's invoice (IDOR)", async () => {
    const { service, storage } = buildService(invoiceRow);
    await expect(service.presignAttachment('att_inv', { id: 'drv_2', type: 'driver' })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(storage.presignGet).not.toHaveBeenCalled();
  });

  it('does not let a user-uploaded file pass the driver own-upload shortcut', async () => {
    const { service } = buildService({ ...invoiceRow, uploadedByType: 'USER' as const });
    await expect(service.presignAttachment('att_inv', { id: 'drv_1', type: 'driver' })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });

  it('lets back office with maintenance READ+ presign a SUBMITTED invoice, not an unsubmitted upload', async () => {
    const submitted = buildService({ ...invoiceRow, maintenanceInvoiceFor: [{ id: 'ms_1' }] });
    await expect(submitted.service.presignAttachment('att_inv', { id: 'usr_1', type: 'user', permissions: { maintenance: 'READ' } })).resolves.toHaveProperty('url', expect.stringContaining('att_inv.pdf'));
    await expect(submitted.service.presignAttachment('att_inv', { id: 'usr_2', type: 'user', permissions: { maintenance: 'NONE' } })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });

    const unsubmitted = buildService(invoiceRow);
    await expect(unsubmitted.service.presignAttachment('att_inv', { id: 'usr_1', type: 'user', permissions: { maintenance: 'FULL' } })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
  });
});
