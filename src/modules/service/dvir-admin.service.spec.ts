import { AppException } from '../../common/errors/app.exception';
import { DvirAdminRepository } from './dvir-admin.repository';
import { DvirAdminService } from './dvir-admin.service';
import { DvirPdfBuilder } from './dvir-pdf.builder';

/** Typed matchers — a bare `expect.any()` is `any` to the linter. */
const ANY_STRING: unknown = expect.any(String);
const ANY_DATE: unknown = expect.any(Date);

describe('DvirAdminService (TZ §5.10 / B-47 compliance)', () => {
  let repo: jest.Mocked<
    Pick<DvirAdminRepository, 'list' | 'findWithDefects' | 'findById' | 'update' | 'findForPdf' | 'activeVehicles' | 'submittedPreTrips' | 'carrierTimezone'>
  >;
  let pdf: jest.Mocked<Pick<DvirPdfBuilder, 'build'>>;
  let service: DvirAdminService;

  beforeEach(() => {
    repo = {
      list: jest.fn(),
      findWithDefects: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      findForPdf: jest.fn(),
      activeVehicles: jest.fn(),
      submittedPreTrips: jest.fn(),
      carrierTimezone: jest.fn().mockResolvedValue('UTC'),
    };
    pdf = { build: jest.fn() };
    service = new DvirAdminService(repo as unknown as DvirAdminRepository, pdf as unknown as DvirPdfBuilder);
  });

  it('404s getting an unknown DVIR', async () => {
    repo.findWithDefects.mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toBeInstanceOf(AppException);
  });

  describe('getPdf (B-75)', () => {
    it('404s for an unknown DVIR without calling the PDF builder', async () => {
      repo.findForPdf.mockResolvedValue(null);
      await expect(service.getPdf('missing')).rejects.toBeInstanceOf(AppException);
      expect(pdf.build).not.toHaveBeenCalled();
    });

    it('builds the PDF from the full DVIR-with-defects-and-names row', async () => {
      const dvir = { id: 'dvir_1', driver: { firstName: 'John', lastName: 'Smith' } };
      repo.findForPdf.mockResolvedValue(dvir as never);
      pdf.build.mockResolvedValue(Buffer.from('PDF-BYTES'));

      const result = await service.getPdf('dvir_1');

      expect(repo.findForPdf).toHaveBeenCalledWith('dvir_1');
      expect(pdf.build).toHaveBeenCalledWith(dvir);
      expect(result.toString()).toBe('PDF-BYTES');
    });
  });

  describe('compliance', () => {
    it('computes expected/submitted/compliancePct and lists missing vehicle/day rows', async () => {
      repo.activeVehicles.mockResolvedValue([
        { id: 'veh_1', unitNumber: '101' },
        { id: 'veh_2', unitNumber: '102' },
      ] as never);
      // veh_1 submits both days; veh_2 submits only the first day.
      repo.submittedPreTrips.mockResolvedValue([
        { vehicleId: 'veh_1', submittedAt: new Date('2026-09-20T08:00:00.000Z') },
        { vehicleId: 'veh_1', submittedAt: new Date('2026-09-21T08:00:00.000Z') },
        { vehicleId: 'veh_2', submittedAt: new Date('2026-09-20T08:00:00.000Z') },
      ] as never);

      const result = await service.compliance({ from: '2026-09-20', to: '2026-09-21' });

      expect(result.expected).toBe(4); // 2 vehicles x 2 days
      expect(result.submitted).toBe(3);
      expect(result.compliancePct).toBe(75);
      expect(result.missing).toEqual([{ vehicleId: 'veh_2', unitNumber: '102', date: '2026-09-21' }]);
    });

    it('reports 100% compliance with no missing rows when every active vehicle submitted every day', async () => {
      repo.activeVehicles.mockResolvedValue([{ id: 'veh_1', unitNumber: '101' }] as never);
      repo.submittedPreTrips.mockResolvedValue([{ vehicleId: 'veh_1', submittedAt: new Date('2026-09-20T08:00:00.000Z') }] as never);

      const result = await service.compliance({ from: '2026-09-20', to: '2026-09-20' });

      expect(result).toEqual({ expected: 1, submitted: 1, compliancePct: 100, missing: [], timezone: 'UTC' });
    });

    it('CODE-074: counts days in the carrier zone — an evening pre-trip in Denver is that day, not the next UTC day', async () => {
      repo.carrierTimezone.mockResolvedValue('America/Denver');
      repo.activeVehicles.mockResolvedValue([{ id: 'veh_1', unitNumber: '101' }] as never);
      // 19:00 MDT on Sep 20 = 01:00Z on Sep 21; 19:00 MDT on Sep 21 = 01:00Z on Sep 22.
      repo.submittedPreTrips.mockResolvedValue([
        { vehicleId: 'veh_1', submittedAt: new Date('2026-09-21T01:00:00.000Z') },
        { vehicleId: 'veh_1', submittedAt: new Date('2026-09-22T01:00:00.000Z') },
      ] as never);

      const result = await service.compliance({ from: '2026-09-20', to: '2026-09-21' });

      expect(result).toMatchObject({ expected: 2, submitted: 2, compliancePct: 100, missing: [] });
      // The submissions are read over the carrier days, 06:00Z Sep 20 → 05:59:59.999Z Sep 22.
      expect(repo.submittedPreTrips).toHaveBeenCalledWith(new Date('2026-09-20T06:00:00.000Z'), new Date('2026-09-22T05:59:59.999Z'));
    });

    it('is 100% compliant (never divide-by-zero) when there are no active vehicles', async () => {
      repo.activeVehicles.mockResolvedValue([]);
      repo.submittedPreTrips.mockResolvedValue([]);

      const result = await service.compliance({ from: '2026-09-20', to: '2026-09-21' });

      expect(result).toEqual({ expected: 0, submitted: 0, compliancePct: 100, missing: [], timezone: 'UTC' });
    });
  });

  describe('mechanicSignOff (QA CODE-035)', () => {
    const dto = { mechanicName: 'Joe', repairStatus: 'REPAIRED' as const };
    const dvir = (over: Record<string, unknown> = {}) => ({ id: 'dvir_1', mechanicSignedAt: null, defects: [{ status: 'REPAIRED' }], ...over });

    it('signs a DVIR whose defects are all resolved', async () => {
      repo.findWithDefects.mockResolvedValue(dvir() as never);
      await service.mechanicSignOff('dvir_1', dto);
      expect(repo.update).toHaveBeenCalledWith({ id: 'dvir_1' }, expect.objectContaining({ repairStatus: 'REPAIRED', mechanicSignedAt: ANY_DATE }));
    });

    it('refuses a second sign-off (409 DVIR_ALREADY_SIGNED)', async () => {
      repo.findWithDefects.mockResolvedValue(dvir({ mechanicSignedAt: new Date() }) as never);
      await expect(service.mechanicSignOff('dvir_1', dto)).rejects.toMatchObject({ status: 409, code: 'DVIR_ALREADY_SIGNED' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it.each([
      ['REPAIRED with an OPEN defect', [{ status: 'OPEN' }], 'REPAIRED'],
      ['REPAIRED with an IN_PROGRESS defect', [{ status: 'IN_PROGRESS' }], 'REPAIRED'],
      ['REPAIRED with no defects', [], 'REPAIRED'],
      ['PENDING', [{ status: 'OPEN' }], 'PENDING'],
    ])('refuses %s (422 on repairStatus)', async (_label, defects, repairStatus) => {
      repo.findWithDefects.mockResolvedValue(dvir({ defects }) as never);
      await expect(service.mechanicSignOff('dvir_1', { mechanicName: 'Joe', repairStatus } as never)).rejects.toMatchObject({
        status: 422,
        details: { repairStatus: ANY_STRING },
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows DEFERRED / NOT_REQUIRED while defects are still open', async () => {
      repo.findWithDefects.mockResolvedValue(dvir({ defects: [{ status: 'OPEN' }] }) as never);
      await service.mechanicSignOff('dvir_1', { mechanicName: 'Joe', repairStatus: 'DEFERRED' });
      expect(repo.update).toHaveBeenCalled();
    });
  });

  describe('nextDriverReview (QA CODE-035)', () => {
    const signedAt = new Date('2026-10-01T10:00:00.000Z');
    const dvir = (over: Record<string, unknown> = {}) => ({
      id: 'dvir_1',
      submittedAt: new Date('2026-10-01T08:00:00.000Z'),
      mechanicSignedAt: signedAt,
      nextDriverReviewedAt: null,
      defects: [{ status: 'REPAIRED' }],
      ...over,
    });

    it('records the review after the sign-off', async () => {
      repo.findWithDefects.mockResolvedValue(dvir() as never);
      await service.nextDriverReview('dvir_1', { reviewedAt: '2026-10-01T12:00:00.000Z' });
      expect(repo.update).toHaveBeenCalledWith({ id: 'dvir_1' }, { nextDriverReviewedAt: new Date('2026-10-01T12:00:00.000Z') });
    });

    it('allows a defect-free DVIR to be reviewed without a sign-off', async () => {
      repo.findWithDefects.mockResolvedValue(dvir({ mechanicSignedAt: null, defects: [] }) as never);
      await service.nextDriverReview('dvir_1', {});
      expect(repo.update).toHaveBeenCalled();
    });

    it('refuses a review before the mechanic sign-off when defects were listed', async () => {
      repo.findWithDefects.mockResolvedValue(dvir({ mechanicSignedAt: null }) as never);
      await expect(service.nextDriverReview('dvir_1', {})).rejects.toMatchObject({ status: 409 });
    });

    it('refuses a second review', async () => {
      repo.findWithDefects.mockResolvedValue(dvir({ nextDriverReviewedAt: new Date() }) as never);
      await expect(service.nextDriverReview('dvir_1', {})).rejects.toMatchObject({ status: 409 });
    });

    it.each([
      ['in the future', () => new Date(Date.now() + 60 * 60_000).toISOString()],
      ['before the sign-off', () => '2026-10-01T09:00:00.000Z'],
    ])('refuses a review time %s', async (_label, at) => {
      repo.findWithDefects.mockResolvedValue(dvir() as never);
      await expect(service.nextDriverReview('dvir_1', { reviewedAt: at() })).rejects.toMatchObject({
        status: 422,
        details: { reviewedAt: ANY_STRING },
      });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});

