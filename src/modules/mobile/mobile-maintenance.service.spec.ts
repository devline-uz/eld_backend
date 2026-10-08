import type { AuditRepository } from '../audit/audit.repository';
import { effectiveStatus, MobileMaintenanceService } from './mobile-maintenance.service';
import type { MobileMaintenanceRepository } from './mobile-maintenance.repository';
import type { MobileRepository } from './mobile.repository';

const DRIVER = 'drv_1';
const UNIT = { vehicleId: 'veh_1', odometerMi: 100_000 };
const SCHEDULE_ID = '3f2c0a7e-0000-4000-8000-000000000001';
const CLIENT_ID = '7d1c2a40-0000-4000-8000-000000000001';
const ATT_ID = '9a1d2b3c-0000-4000-8000-000000000009';

function row(over: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    vehicleId: 'veh_1',
    name: 'Engine oil & filter',
    scheduleType: 'OIL_CHANGE',
    intervalMi: 25_000,
    intervalDays: null,
    lastServiceMi: 76_000,
    lastServiceAt: new Date('2026-08-01T00:00:00Z'),
    nextDueMi: 101_000,
    nextDueAt: null,
    enabled: true,
    status: 'OPEN',
    invoiceNumber: null,
    vendorName: null,
    cost: null,
    invoiceNotes: null,
    invoiceAttachmentId: null,
    submittedById: null,
    submittedAt: null,
    reviewNote: null,
    reviewedAt: null,
    reviewedById: null,
    invoiceAttachment: null,
    ...over,
  };
}

const SUBMIT = { invoiceNumber: 'INV-2291', vendorName: 'Pilot Truck Care', cost: 412.5, notes: 'filters too', invoiceAttachmentId: ATT_ID, clientId: CLIENT_ID };

function build() {
  const repo = {
    findDriverUnit: jest.fn().mockResolvedValue(UNIT),
    listForVehicle: jest.fn().mockResolvedValue([]),
    findOneForVehicle: jest.fn().mockResolvedValue(row()),
    findOwnInvoiceAttachment: jest.fn().mockResolvedValue({ id: ATT_ID }),
    saveSubmission: jest.fn().mockImplementation(async (_id: string, data: Record<string, unknown>) =>
      row({ ...data, cost: data.cost, invoiceAttachment: data.invoiceAttachmentId ? { id: ATT_ID, key: `invoices/${DRIVER}/${ATT_ID}.pdf`, mimeType: 'application/pdf' } : null }),
    ),
  };
  const mobileRepo = {
    findSyncedByClientId: jest.fn().mockResolvedValue(null),
    recordSyncedResult: jest.fn().mockResolvedValue({ status: 'ACCEPTED', errorCode: null }),
  };
  const audit = { insert: jest.fn().mockResolvedValue(undefined) };
  const service = new MobileMaintenanceService(repo as unknown as MobileMaintenanceRepository, mobileRepo as unknown as MobileRepository, audit as unknown as AuditRepository);
  return { service, repo, mobileRepo, audit };
}

describe('MobileMaintenanceService (M-38..M-42)', () => {
  describe('list', () => {
    it('is empty when the driver has no selected unit, without touching the schedule table', async () => {
      const { service, repo } = build();
      repo.findDriverUnit.mockResolvedValueOnce(null);
      await expect(service.list(DRIVER)).resolves.toEqual([]);
      expect(repo.listForVehicle).not.toHaveBeenCalled();
    });

    it('maps rows (frequencyMi, remainingMi vs the unit odometer) and lists actionable rows first, most overdue first', async () => {
      const { service, repo } = build();
      repo.listForVehicle.mockResolvedValueOnce([
        row({ id: 'done', name: 'A done', status: 'COMPLETED', lastServiceMi: 99_000, lastServiceAt: new Date('2026-10-01T00:00:00Z') }),
        row({ id: 'later', name: 'Later', lastServiceMi: 90_000 }),
        row({ id: 'overdue', name: 'Overdue', lastServiceMi: 70_000 }),
      ]);
      const out = await service.list(DRIVER);
      expect(repo.findDriverUnit).toHaveBeenCalledTimes(1);
      expect(repo.listForVehicle).toHaveBeenCalledWith('veh_1');
      expect(out.map((r) => r.id)).toEqual(['overdue', 'later', 'done']);
      expect(out[0]).toMatchObject({ scheduleType: 'OIL_CHANGE', scheduleName: 'Overdue', frequencyMi: 25_000, remainingMi: -5000, status: 'OPEN' });
      expect(out[1].remainingMi).toBe(15_000);
      expect(out[2]).toMatchObject({ status: 'COMPLETED', at: '2026-10-01T00:00:00.000Z' });
    });

    it('shows a COMPLETED recurring task as OPEN again once its interval has come round', () => {
      const completedLongAgo = row({ status: 'COMPLETED', lastServiceMi: 70_000 }) as never;
      expect(effectiveStatus(completedLongAgo, 100_000, new Date())).toBe('OPEN');
      const completedJustNow = row({ status: 'COMPLETED', lastServiceMi: 99_500 }) as never;
      expect(effectiveStatus(completedJustNow, 100_000, new Date())).toBe('COMPLETED');
    });
  });

  describe('get', () => {
    it('404s a task that is not on the selected unit (or when no unit is selected)', async () => {
      const { service, repo } = build();
      repo.findOneForVehicle.mockResolvedValueOnce(null);
      await expect(service.get(DRIVER, SCHEDULE_ID)).rejects.toMatchObject({ code: 'MAINTENANCE_SCHEDULE_NOT_FOUND' });
      expect(repo.findOneForVehicle).toHaveBeenCalledWith(SCHEDULE_ID, 'veh_1');
      repo.findDriverUnit.mockResolvedValueOnce(null);
      await expect(service.get(DRIVER, SCHEDULE_ID)).rejects.toMatchObject({ code: 'MAINTENANCE_SCHEDULE_NOT_FOUND' });
    });

    it('returns invoice fields, attachment {id,fileName,mimeType}, submittedAt and reviewNote', async () => {
      const { service, repo } = build();
      repo.findOneForVehicle.mockResolvedValueOnce(
        row({
          status: 'REJECTED',
          invoiceNumber: 'INV-2291',
          vendorName: 'Pilot',
          cost: '412.50',
          invoiceNotes: 'n',
          submittedAt: new Date('2026-10-08T12:00:00Z'),
          reviewNote: 'Amount mismatch',
          invoiceAttachment: { id: ATT_ID, key: 'invoices/drv_1/x.pdf', mimeType: 'application/pdf' },
        }),
      );
      const out = await service.get(DRIVER, SCHEDULE_ID);
      expect(out).toMatchObject({
        status: 'REJECTED',
        invoiceNumber: 'INV-2291',
        vendorName: 'Pilot',
        cost: 412.5,
        notes: 'n',
        invoiceAttachment: { id: ATT_ID, fileName: 'invoice-INV-2291.pdf', mimeType: 'application/pdf' },
        submittedAt: '2026-10-08T12:00:00.000Z',
        reviewNote: 'Amount mismatch',
        at: '2026-10-08T12:00:00.000Z',
      });
    });
  });

  describe('submit', () => {
    it('stores the invoice, keeps the task OPEN with submittedAt, records the ledger row and audits', async () => {
      const { service, repo, mobileRepo, audit } = build();
      const out = await service.submit(DRIVER, SCHEDULE_ID, SUBMIT);
      expect(repo.findOwnInvoiceAttachment).toHaveBeenCalledWith(ATT_ID, DRIVER, SCHEDULE_ID);
      const [id, data] = repo.saveSubmission.mock.calls[0] as [string, Record<string, unknown>];
      expect(id).toBe(SCHEDULE_ID);
      expect(data).toMatchObject({ status: 'OPEN', invoiceNumber: 'INV-2291', vendorName: 'Pilot Truck Care', cost: 412.5, invoiceNotes: 'filters too', invoiceAttachmentId: ATT_ID, submittedById: DRIVER, reviewNote: null });
      expect(out).toMatchObject({ status: 'OPEN', invoiceNumber: 'INV-2291', cost: 412.5, reviewNote: null });
      expect(out.submittedAt).not.toBeNull();
      expect(mobileRepo.recordSyncedResult).toHaveBeenCalledWith(DRIVER, CLIENT_ID, 'maintenance_submit', expect.any(Date), 'ACCEPTED', null, expect.objectContaining({ id: SCHEDULE_ID }));
      expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({ action: 'MAINTENANCE_SUBMITTED', objectType: 'MaintenanceSchedule', objectId: SCHEDULE_ID, actorType: 'DRIVER' }));
    });

    it('replays the first answer for the same clientId without writing again', async () => {
      const { service, repo, mobileRepo } = build();
      mobileRepo.findSyncedByClientId.mockResolvedValueOnce({ type: 'maintenance_submit', status: 'ACCEPTED', result: { id: SCHEDULE_ID, status: 'OPEN', marker: 'first' } });
      await expect(service.submit(DRIVER, SCHEDULE_ID, SUBMIT)).resolves.toMatchObject({ marker: 'first' });
      expect(repo.saveSubmission).not.toHaveBeenCalled();
      expect(mobileRepo.recordSyncedResult).not.toHaveBeenCalled();
    });

    it('409s a clientId replayed against a DIFFERENT task instead of returning that task (B-150)', async () => {
      const { service, repo, mobileRepo } = build();
      mobileRepo.findSyncedByClientId.mockResolvedValueOnce({ type: 'maintenance_submit', status: 'ACCEPTED', result: { id: 'other-task', status: 'OPEN' } });
      await expect(service.submit(DRIVER, SCHEDULE_ID, SUBMIT)).rejects.toMatchObject({ status: 409 });
      expect(repo.saveSubmission).not.toHaveBeenCalled();
      expect(mobileRepo.findSyncedByClientId).toHaveBeenCalledWith(DRIVER, CLIENT_ID);
    });

    it('409s a clientId already spent on another operation type', async () => {
      const { service, repo, mobileRepo } = build();
      mobileRepo.findSyncedByClientId.mockResolvedValueOnce({ type: 'release_vehicle', status: 'ACCEPTED', result: { released: true } });
      await expect(service.submit(DRIVER, SCHEDULE_ID, SUBMIT)).rejects.toMatchObject({ status: 409 });
      expect(repo.saveSubmission).not.toHaveBeenCalled();
    });

    it('404s a task of another unit and writes nothing', async () => {
      const { service, repo } = build();
      repo.findOneForVehicle.mockResolvedValueOnce(null);
      await expect(service.submit(DRIVER, SCHEDULE_ID, SUBMIT)).rejects.toMatchObject({ code: 'MAINTENANCE_SCHEDULE_NOT_FOUND' });
      expect(repo.saveSubmission).not.toHaveBeenCalled();
    });

    it.each(['CANCELLED'])('409s a %s task', async (status) => {
      const { service, repo } = build();
      repo.findOneForVehicle.mockResolvedValueOnce(row({ status }));
      await expect(service.submit(DRIVER, SCHEDULE_ID, SUBMIT)).rejects.toMatchObject({ status: 409 });
      expect(repo.saveSubmission).not.toHaveBeenCalled();
    });

    it('409s a COMPLETED task that is not due again, but accepts a resubmission of a REJECTED one and clears the verdict', async () => {
      const { service, repo } = build();
      repo.findOneForVehicle.mockResolvedValueOnce(row({ status: 'COMPLETED', lastServiceMi: 99_500 }));
      await expect(service.submit(DRIVER, SCHEDULE_ID, SUBMIT)).rejects.toMatchObject({ status: 409 });

      repo.findOneForVehicle.mockResolvedValueOnce(row({ status: 'REJECTED', reviewNote: 'bad', reviewedAt: new Date(), reviewedById: 'usr_1' }));
      const out = await service.submit(DRIVER, SCHEDULE_ID, SUBMIT);
      expect(out.status).toBe('OPEN');
      expect((repo.saveSubmission.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ reviewNote: null, reviewedAt: null, reviewedById: null });
    });

    it("422s an invoiceAttachmentId that is not this driver's INVOICE upload, before writing", async () => {
      const { service, repo } = build();
      repo.findOwnInvoiceAttachment.mockResolvedValueOnce(null);
      await expect(service.submit(DRIVER, SCHEDULE_ID, SUBMIT)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      expect(repo.saveSubmission).not.toHaveBeenCalled();
    });

    it('accepts a submission without an attachment', async () => {
      const { service, repo } = build();
      const out = await service.submit(DRIVER, SCHEDULE_ID, { ...SUBMIT, invoiceAttachmentId: null, notes: undefined });
      expect(repo.findOwnInvoiceAttachment).not.toHaveBeenCalled();
      expect(out.invoiceAttachment).toBeNull();
    });
  });
});
