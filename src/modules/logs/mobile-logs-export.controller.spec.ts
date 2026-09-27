import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DriverGuard } from '../../common/guards/driver.guard';
import { RequestContext } from '../../core/context/request-context';
import { LogExportDateParamDto, LogExportFormatQueryDto } from './dto/logs.dto';
import { MobileLogsExportController } from './mobile-logs-export.controller';

describe('MobileLogsExportController (MB-18)', () => {
  const service = { exportDay: jest.fn().mockResolvedValue({ fileName: 'RODS_2026-09-10.csv', contentType: 'text/csv; charset=utf-8', body: 'sequenceId\r\n' }) };
  const controller = new MobileLogsExportController(service as never);
  const driver = { id: 'drv_1', type: 'driver' as const };

  it('is guarded by DriverGuard; a back-office token gets 403 DRIVER_CONTEXT_REQUIRED', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MobileLogsExportController)).toContain(DriverGuard);
    const guard = new DriverGuard();
    const ctx = { requestId: 'r', traceId: 't', startedAt: 0, user: { id: 'usr_1', type: 'user' as const, role: 'ADMIN' } };
    let thrown: unknown;
    try {
      RequestContext.run(ctx, () => guard.canActivate({} as never));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: 'DRIVER_CONTEXT_REQUIRED', status: 403 });
  });

  it('returns the raw CSV string (envelope bypass) with attachment headers; driver id from the token', async () => {
    const res = { setHeader: jest.fn() };
    const body = await controller.exportDay(LogExportDateParamDto.parse({ date: '2026-09-10' }), LogExportFormatQueryDto.parse({}), driver, res as never);
    expect(service.exportDay).toHaveBeenCalledWith('drv_1', '2026-09-10', 'csv');
    expect(typeof body).toBe('string');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="RODS_2026-09-10.csv"');
  });

  it('DTOs: date must be YYYY-MM-DD, format only csv|pdf', () => {
    expect(LogExportDateParamDto.safeParse({ date: '10/09/2026' }).success).toBe(false);
    expect(LogExportFormatQueryDto.safeParse({ format: 'xlsx' }).success).toBe(false);
    expect(LogExportFormatQueryDto.parse({ format: 'pdf' }).format).toBe('pdf');
  });
});
