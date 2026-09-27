import { AppException } from '../../common/errors/app.exception';
import { DvirAdminRepository } from './dvir-admin.repository';
import { DvirAdminService } from './dvir-admin.service';
import { DvirPdfBuilder } from './dvir-pdf.builder';

describe('DvirAdminService (TZ §5.10 / B-47 compliance)', () => {
  let repo: jest.Mocked<
    Pick<DvirAdminRepository, 'list' | 'findWithDefects' | 'findById' | 'update' | 'findForPdf' | 'activeVehicles' | 'submittedPreTrips'>
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

      expect(result).toEqual({ expected: 1, submitted: 1, compliancePct: 100, missing: [] });
    });

    it('is 100% compliant (never divide-by-zero) when there are no active vehicles', async () => {
      repo.activeVehicles.mockResolvedValue([]);
      repo.submittedPreTrips.mockResolvedValue([]);

      const result = await service.compliance({ from: '2026-09-20', to: '2026-09-21' });

      expect(result).toEqual({ expected: 0, submitted: 0, compliancePct: 100, missing: [] });
    });
  });
});
