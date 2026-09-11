import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { CreateTransferDto, TransferListQueryDto } from './dto/transfers.dto';
import { TransfersService } from './transfers.service';

/**
 * TZ §10 / §11.4 — `GET/POST /transfers` plus the §10.1 download.
 *
 * Permission key `reportsTransfer` (§6.4): ADMIN and FLEET_MANAGER FULL, DISPATCHER and
 * VIEWER NONE — "the FMCSA package is sent by the Administrator and the Fleet manager only".
 * Because DISPATCHER/VIEWER are NONE, even the READ-level download is a 403 for them.
 */
@FigmaScreen('web/send-logs-to-safety-official', 'web/reports-fmcsa-audit-pack')
@ApiTags('transfers')
@ApiBearerAuth()
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @Perm('reportsTransfer', 'FULL')
  @ApiOperation({
    summary:
      'Requests an eRODS data transfer: generates the §395 Appendix A output file, validates it, stores it and queues the send step. In TEST mode the file is NOT sent to FMCSA.',
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('reportsTransfer = FULL is required — only ADMIN and FLEET_MANAGER may send the FMCSA package (§6.4).'),
      apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'),
      apiError.unprocessable(ERROR_CODES.INVALID_TRANSFER_RECIPIENT, 'Email transfer is accepted only for an fmcsa.dot.gov address (§10).'),
      { status: 422, code: ERROR_CODES.RANGE_TOO_LARGE, message: 'The requested date range exceeds the allowed transfer window.' },
      { status: 422, code: ERROR_CODES.TRANSFER_VALIDATION_FAILED, message: 'The generated output file failed Appendix A validation — nothing was sent.', details: { uncertifiedLogs: 6, unassignedSegments: 9 } },
    ],
  })
  @ApiOkResponse({
    schema: {
      example: {
        transfer: {
          id: 'trf_1',
          fileName: 'SMITH38018.csv',
          status: 'QUEUED',
          erodsMode: 'TEST',
          fileSizeBytes: 2048,
        },
        warnings: [{ code: 'ERODS_TEST_MODE', level: 'warning', message: 'eRODS is in TEST mode …' }],
        counts: { header: 9, events: 42 },
      },
    },
  })
  create(@Body(zodBody(CreateTransferDto)) dto: CreateTransferDto, @CurrentUser() actor: ContextUser) {
    return this.transfers.create(dto, actor);
  }

  @Get()
  @Perm('reportsTransfer', 'READ')
  @ApiOperation({ summary: 'Transfer history (§10). `TEST_ONLY` rows are files that were generated but never sent.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'trf_1', sentAt: '2026-09-02T13:14:00.000Z', method: 'WEB_SERVICES', comment: 'TERMINAL AUDIT 2025-09-02', periodFrom: '2026-07-01', periodTo: '2026-08-31', status: 'ACCEPTED', sentById: 'usr_1', fileName: 'SMITH38018.csv' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  list(@Query(zodBody(TransferListQueryDto)) query: TransferListQueryDto) {
    return this.transfers.list(query);
  }

  @Get(':id')
  @Perm('reportsTransfer', 'READ')
  @ApiOperation({ summary: 'One transfer record.' })
  @ApiOkResponse({ schema: { example: { id: 'trf_1', method: 'WEB_SERVICES', status: 'ACCEPTED', erodsMode: 'TEST', comment: 'ROADSIDE INSPECTION 2026-09-10', fileName: 'SMITH38018.csv', fileSizeBytes: 2048, counts: { header: 9, events: 42 }, sentAt: '2026-09-11T15:41:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Transfer not found.')] })
  get(@Param('id') id: string) {
    return this.transfers.get(id);
  }

  @Get(':id/download')
  @Perm('reportsTransfer', 'READ')
  @ApiOperation({
    summary:
      'Downloads the generated Appendix A output file under its 4.8.2.2 file name. Works in TEST mode — that is how the file reaches an inspector until FMCSA registration completes.',
  })
  @ApiOkResponse({
    description: 'The Appendix A CSV itself (text/csv), named per §4.8.2.2. Not wrapped in the success envelope.',
    content: {
      'text/csv': {
        schema: { type: 'string' },
        example:
          'Header,ONEB01,Universal Logistics Inc.,1234567\nUser,Smith,John,W8569238,OH\nCMV,101,1FUJGLDR8LLLL1234,993107\n',
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('reportsTransfer is NONE for DISPATCHER and VIEWER — even the download is a 403 (§6.4).'),
      apiError.notFound(ERROR_CODES.NOT_FOUND, 'Transfer not found.'),
      apiError.unprocessable(ERROR_CODES.CHECKSUM_MISMATCH, 'The stored output file does not match its checksum — it is not trustworthy.'),
    ],
  })
  async download(
    @Param('id') id: string,
    @CurrentUser() actor: ContextUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { fileName, csv } = await this.transfers.download(id, actor);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    // Returning a string opts out of the success envelope (TransformInterceptor).
    return csv;
  }
}
