const renderPdf = jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
jest.mock('../reports/lib/pdf-render', () => ({ renderPdf: (...a: unknown[]): unknown => renderPdf(...a) }));
import { MobileLogsExportService } from './mobile-logs-export.service';

describe('MobileLogsExportService (MB-18)', () => {
  const repo = {
    findDriver: jest.fn().mockResolvedValue({ id: 'drv_1', homeTerminalTimezone: 'America/New_York' }),
    findTripsForDriver: jest.fn().mockResolvedValue([]),
    findDailyLogs: jest.fn().mockResolvedValue([]),
    findEvents: jest.fn().mockResolvedValue([
      { eventSequenceId: 1, eventType: 1, eventCode: 1, eventDateTime: new Date('2026-09-10T04:00:00Z'), recordStatus: 1, recordOrigin: 1, locationName: null, totalVehicleMiles: 10, totalEngineHours: null, annotation: null },
      // Exactly next local midnight belongs to the NEXT day (half-open window, like the inspection packet).
      { eventSequenceId: 2, eventType: 1, eventCode: 4, eventDateTime: new Date('2026-09-11T04:00:00Z'), recordStatus: 1, recordOrigin: 1, locationName: null, totalVehicleMiles: 11, totalEngineHours: null, annotation: null },
    ]),
  };
  const prisma = {
    findCarrier: jest.fn().mockResolvedValue({ name: 'Acme Freight', dotNumber: '1234567', addressLine1: '1 Main St', city: 'Columbus', state: 'OH', zip: '43004' }),
    findVehicles: jest.fn().mockResolvedValue([]),
  };
  const service = new MobileLogsExportService(repo as never, prisma as never);

  it('csv: queries the home-terminal day window and returns text/csv with the day file name', async () => {
    const out = await service.exportDay('drv_1', '2026-09-10', 'csv');
    expect(repo.findEvents).toHaveBeenCalledWith('drv_1', new Date('2026-09-10T04:00:00.000Z'), new Date('2026-09-11T04:00:00.000Z'));
    expect(out.fileName).toBe('RODS_2026-09-10.csv');
    expect(out.contentType).toBe('text/csv; charset=utf-8');
    const lines = String(out.body).split('\r\n');
    expect(lines[1]).toBe('1,1,1,2026-09-10 00:00:00,OFF,,10,,ELD,ACTIVE,');
    expect(lines).toHaveLength(3);
  });

  it('pdf (MB-4): renders the rods-day template with header fields, graph boxes and totals', async () => {
    repo.findDriver.mockResolvedValueOnce({ id: 'drv_1', firstName: 'John', lastName: 'Smith', cdlNumber: 'D123', cdlState: 'OH', homeTerminalName: 'Columbus', homeTerminalTimezone: 'America/New_York' });
    repo.findEvents.mockResolvedValueOnce([
      { id: 1n, eventSequenceId: 1, eventType: 1, eventCode: 1, eventDateTime: new Date('2026-09-10T04:00:00Z'), recordStatus: 1, recordOrigin: 1, locationName: 'Columbus, OH', totalVehicleMiles: 100, totalEngineHours: null, annotation: null, vehicleId: null },
      { id: 2n, eventSequenceId: 2, eventType: 1, eventCode: 3, eventDateTime: new Date('2026-09-10T10:00:00Z'), recordStatus: 1, recordOrigin: 1, locationName: 'Dayton, OH', totalVehicleMiles: 110, totalEngineHours: null, annotation: null, vehicleId: null },
      { id: 3n, eventSequenceId: 3, eventType: 1, eventCode: 1, eventDateTime: new Date('2026-09-10T14:00:00Z'), recordStatus: 1, recordOrigin: 1, locationName: 'Dayton, OH', totalVehicleMiles: 160, totalEngineHours: null, annotation: null, vehicleId: null },
    ]);
    const out = await service.exportDay('drv_1', '2026-09-10', 'pdf', new Date('2026-09-12T00:00:00Z'));
    expect(out.fileName).toBe('RODS_2026-09-10.pdf');
    expect(out.contentType).toBe('application/pdf');
    expect(Buffer.isBuffer(out.body)).toBe(true);
    const [name, data] = renderPdf.mock.calls[0] as [string, { rowTotals: { total: string }[]; lines: unknown[]; links: unknown[]; remarks: unknown[] } & Record<string, unknown>];
    expect(name).toBe('rods-day');
    expect(data).toMatchObject({ date: '2026-09-10', driverName: 'Smith, John', carrierName: 'Acme Freight', carrierDot: '1234567', totalHours: '24:00' });
    expect(data.rowTotals.map((r) => r.total)).toEqual(['20:00', '0:00', '4:00', '0:00']);
    expect(data.lines).toHaveLength(3);
    expect(data.links).toHaveLength(2);
    expect(data.remarks[1]).toMatchObject({ time: '06:00', status: 'D', location: 'Dayton, OH' });
  });

  it('unknown driver → 404 DRIVER_NOT_FOUND', async () => {
    repo.findDriver.mockResolvedValueOnce(null);
    await expect(service.exportDay('nope', '2026-09-10', 'csv')).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND', status: 404 });
  });
});
