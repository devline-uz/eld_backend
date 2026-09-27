import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiOperation({
    summary: "Downloads one of the driver's own RODS days. format=csv → text/csv (every §395 record of the day, home-terminal local time). format=pdf → 501 NOT_IMPLEMENTED for now.",
  })
  @ApiOkResponse({
    description: 'Raw CSV (not wrapped in the success envelope), `Content-Disposition: attachment; filename="RODS_<date>.csv"`.',
    content: {
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
      { status: 501, code: ERROR_CODES.NOT_IMPLEMENTED, message: 'PDF export of a RODS day is not available yet.' },
    ],
  })
  async exportDay(
    @Param(zodBody(LogExportDateParamDto)) params: LogExportDateParamDto,
    @Query(zodBody(LogExportFormatQueryDto)) query: LogExportFormatQueryDto,
    @CurrentUser() actor: ContextUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const file = await this.exporter.exportDay(actor.id, params.date, query.format);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    // A string return value opts out of the JSON success envelope (TransformInterceptor).
    return file.body;
  }
}
