jest.mock('../reports/lib/pdf-render', () => ({
  renderPdf: jest.fn(async (_name: string, data: Record<string, unknown>) => Buffer.from(JSON.stringify(data))),
}));

import { DvirPdfBuilder } from './dvir-pdf.builder';
import { renderPdf } from '../reports/lib/pdf-render';
import type { DvirForPdf } from './dvir-pdf.builder';

/** B-75 — `GET /dvir/:id/pdf` must carry the §396.11 inspection record, defects and both
 * signatures (driver's signature image + the mechanic's text attestation, see class doc). */
describe('DvirPdfBuilder', () => {
  function makeDvir(overrides: Partial<DvirForPdf> = {}): DvirForPdf {
    return {
      id: 'dvir_1',
      driverId: 'drv_1',
      vehicleId: 'veh_1',
      trailerId: null,
      type: 'PRE_TRIP',
      submittedAt: new Date('2026-09-20T08:00:00.000Z'),
      odometerMi: 99000,
      latitude: null,
      longitude: null,
      locationName: 'New Haven, CT',
      vehicleCondition: 'DEFECTS_FOUND',
      driverSignatureUrl: 'signatures/dvir_1.png',
      driverSignatureHash: null,
      notes: 'Cracked mirror',
      mechanicName: 'J. Alvarez',
      mechanicSignedAt: new Date('2026-09-20T15:00:00.000Z'),
      mechanicNote: 'Replaced mirror',
      repairStatus: 'REPAIRED',
      nextDriverReviewedAt: null,
      createdAt: new Date('2026-09-20T08:00:00.000Z'),
      defects: [
        {
          id: 'def_1',
          dvirId: 'dvir_1',
          vehicleId: 'veh_1',
          category: 'MIRRORS',
          part: 'TRUCK',
          severity: 'MAJOR',
          description: 'Cracked mirror',
          status: 'RESOLVED',
          outOfService: false,
          workOrderId: null,
          resolvedAt: null,
          resolvedById: null,
          resolutionNote: null,
          resolutionType: null,
          correctedBy: null,
          completedAt: null,
          laborHours: null,
          partsCostUsd: null,
          assigneeId: null,
          createdAt: new Date('2026-09-20T08:00:00.000Z'),
          photos: [],
        },
      ],
      photos: [],
      driver: { firstName: 'John', lastName: 'Smith', cdlNumber: 'CDL-1' },
      vehicle: { unitNumber: '101', vin: '1FUJGLDR9CSBK1234', licensePlate: 'ABC123', plateState: 'CT' },
      trailer: null,
      ...overrides,
    } as DvirForPdf;
  }

  it('presigns the driver signature and renders the dvir-single template with defects/signatures', async () => {
    const storage = { presignGet: jest.fn(async (key: string) => `https://minio.local/${key}?sig=1`) };
    const builder = new DvirPdfBuilder(storage as never);

    const pdf = await builder.build(makeDvir());

    expect(storage.presignGet).toHaveBeenCalledWith('signatures/dvir_1.png', 15 * 60);
    const [name, data] = (renderPdf as jest.Mock).mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(name).toBe('dvir-single');
    expect(data.driverSignatureUrl).toBe('https://minio.local/signatures/dvir_1.png?sig=1');
    expect(data.driverName).toBe('Smith, John');
    expect(data.mechanicName).toBe('J. Alvarez');
    expect((data.defects as unknown[]).length).toBe(1);
    expect(pdf).toBeInstanceOf(Buffer);
  });

  it('falls back to raw ids/placeholders when driver/vehicle/trailer relations are missing', async () => {
    const storage = { presignGet: jest.fn(async () => 'https://minio.local/x') };
    const builder = new DvirPdfBuilder(storage as never);

    await builder.build(makeDvir({ driver: null, vehicle: null, trailer: null }));

    const [, data] = (renderPdf as jest.Mock).mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(data.driverName).toBe('drv_1');
    expect(data.vehicleUnit).toBe('veh_1');
    expect(data.trailerUnit).toBe('—');
  });
});
