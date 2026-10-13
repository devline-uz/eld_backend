import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { resolveDriverTracker, type TrackableRequest } from '../../common/throttler/principal-tracker';
import { ApiBearerAuth, ApiOkResponse, ApiProduces, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { LogExportFormatQueryDto, LogExportDateParamDto } from './dto/logs.dto';
import { MobileLogsExportService } from './mobile-logs-export.service';

/**
 * mobile/tz.md §21 MB-18 / screen P-05 `Download` — one RODS day of the token's driver as a
 * file. Driver token only (MD-001); the driver id never comes from the path.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/logs')
export class MobileLogsExportController {
  constructor(private readonly exporter: MobileLogsExportService) {}

  @Get(':date/export')
  // B-161 — CSV/PDF rendering is CPU-heavy; 10/min per DRIVER (not per IP: a fleet shares a depot NAT).
  @Throttle({ default: { limit: 10, ttl: 60_000, getTracker: (req: TrackableRequest) => resolveDriverTracker(req) } })
  @ApiOperation({
    summary: "Downloads one of the driver's own RODS days. format=csv → text/csv (every §395 record of the day, home-terminal local time). format=pdf → application/pdf §395.8 daily-log sheet (header fields, 24 h graph grid, remarks).",
  })
  @ApiProduces('text/csv', 'application/pdf')
  @ApiOkResponse({
    description: 'Raw file (not wrapped in the success envelope), `Content-Disposition: attachment; filename="RODS_<date>.csv|pdf"`.',
    content: {
      'application/pdf': { schema: { type: 'string', format: 'binary', example: '%PDF-1.4 ...' } },
      'text/csv': {
        schema: { type: 'string' },
        example: 'sequenceId,eventType,eventCode,eventDateTime,status,location,odometerMi,engineHours,origin,recordStatus,annotation\r\n17,1,3,2026-09-10 09:00:00,D,"New Haven, CT",993107,4321.4,ELD,ACTIVE,\r\n',
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('Driver token required (DRIVER_CONTEXT_REQUIRED).'),
      apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'),
    ],
  })
  async exportDay(
    @Param(zodBody(LogExportDateParamDto)) params: LogExportDateParamDto,
    @Query(zodBody(LogExportFormatQueryDto)) query: LogExportFormatQueryDto,
    @CurrentUser() actor: ContextUser,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.exporter.exportDay(actor.id, params.date, query.format);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    // Written directly (no passthrough): the envelope interceptor is bypassed and a Buffer is
    // never JSON-serialised by the Express adapter.
    res.send(file.body);
  }
}
