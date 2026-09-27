import { MobileLogsExportService } from './mobile-logs-export.service';

describe('MobileLogsExportService (MB-18)', () => {
  const repo = {
    findDriver: jest.fn().mockResolvedValue({ id: 'drv_1', homeTerminalTimezone: 'America/New_York' }),
    findEvents: jest.fn().mockResolvedValue([
      { eventSequenceId: 1, eventType: 1, eventCode: 1, eventDateTime: new Date('2026-09-10T04:00:00Z'), recordStatus: 1, recordOrigin: 1, locationName: null, totalVehicleMiles: 10, totalEngineHours: null, annotation: null },
      // Exactly next local midnight belongs to the NEXT day (half-open window, like the inspection packet).
      { eventSequenceId: 2, eventType: 1, eventCode: 4, eventDateTime: new Date('2026-09-11T04:00:00Z'), recordStatus: 1, recordOrigin: 1, locationName: null, totalVehicleMiles: 11, totalEngineHours: null, annotation: null },
    ]),
  };
  const service = new MobileLogsExportService(repo as never);

  it('csv: queries the home-terminal day window and returns text/csv with the day file name', async () => {
    const out = await service.exportDay('drv_1', '2026-09-10', 'csv');
    expect(repo.findEvents).toHaveBeenCalledWith('drv_1', new Date('2026-09-10T04:00:00.000Z'), new Date('2026-09-11T04:00:00.000Z'));
    expect(out.fileName).toBe('RODS_2026-09-10.csv');
    expect(out.contentType).toBe('text/csv; charset=utf-8');
    const lines = out.body.split('\r\n');
    expect(lines[1]).toBe('1,1,1,2026-09-10 00:00:00,OFF,,10,,ELD,ACTIVE,');
    expect(lines).toHaveLength(3);
  });

  it('pdf: 501 NOT_IMPLEMENTED (no RODS-day PDF template yet)', async () => {
    await expect(service.exportDay('drv_1', '2026-09-10', 'pdf')).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED', status: 501 });
  });

  it('unknown driver → 404 DRIVER_NOT_FOUND', async () => {
    repo.findDriver.mockResolvedValueOnce(null);
    await expect(service.exportDay('nope', '2026-09-10', 'csv')).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND', status: 404 });
  });
});
