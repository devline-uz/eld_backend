import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { MobileCreateTransferDto, MobileTransferListQueryDto } from './dto/mobile-transfers.dto';
import { MobileTransfersService } from './mobile-transfers.service';

/**
 * mobile/tz.md §21 MB-4 / §8.5 / screens M-28, S-10, P-13 — the driver sends their OWN eRODS
 * file from the app (49 CFR §395.24(d), §395.34). Driver token only; the driver id is never
 * taken from the body. Web `/transfers` (`reportsTransfer` perm) is untouched (MD-001).
 */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/transfers')
export class MobileTransfersController {
  constructor(private readonly transfers: MobileTransfersService) {}

  @Post()
  @ApiOperation({
    summary:
      "Driver-initiated eRODS transfer of the driver's own RODS: generates and validates the §395 Appendix A file, stores it, queues the send. TEST mode never sends to FMCSA (status TEST_ONLY).",
    description:
      'The row is returned as it stands right after generation (`status = QUEUED`); the worker moves it to TEST_ONLY / SENT / ACCEPTED / REJECTED / FAILED and fills `referenceId` + `sentAt`. Poll `GET /mobile/transfers` for the receipt (S-10).',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        id: 'trf_1',
        method: 'WEB_SERVICES',
        status: 'QUEUED',
        erodsMode: 'TEST',
        referenceId: null,
        sentAt: null,
        createdAt: '2026-09-10T15:44:02.000Z',
        fileName: 'SMITH38018.csv',
        outputFileComment: 'ROADSIDE INSPECTION 2026-09-10',
        rangeStart: '2026-09-03',
        rangeEnd: '2026-09-10',
        warnings: ['ERODS_TEST_MODE'],
        counts: { header: 9, events: 42 },
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('Driver token required (DRIVER_CONTEXT_REQUIRED).'),
      apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'),
      apiError.unprocessable(ERROR_CODES.INVALID_TRANSFER_RECIPIENT, 'Email transfer is accepted only for an fmcsa.dot.gov address (§10).'),
      { status: 422, code: ERROR_CODES.RANGE_TOO_LARGE, message: 'The requested date range exceeds the allowed transfer window.' },
      { status: 422, code: ERROR_CODES.OUTPUT_FILE_INVALID, message: 'The generated output file does not conform to §395 Appendix A and was not stored.' },
    ],
  })
  create(@Body(zodBody(MobileCreateTransferDto)) dto: MobileCreateTransferDto, @CurrentUser() actor: ContextUser) {
    return this.transfers.create(actor, dto);
  }

  @Get()
  @ApiOperation({ summary: "The driver's own most recent transfers (receipts for S-10 / M-27 `Last transfer`)." })
  @ApiOkResponse({
    schema: {
      example: {
        items: [
          { id: 'trf_1', method: 'WEB_SERVICES', status: 'TEST_ONLY', erodsMode: 'TEST', referenceId: 'ERODS-TEST-26-0910-4821', sentAt: '2026-09-10T15:44:02.000Z', createdAt: '2026-09-10T15:44:00.000Z', fileName: 'SMITH38018.csv', outputFileComment: 'ROADSIDE INSPECTION 2026-09-10', rangeStart: '2026-09-03', rangeEnd: '2026-09-10' },
        ],
        total: 1,
        limit: 5,
      },
    },
  })
  @ApiStandardErrors({ errors: [apiError.forbidden('Driver token required (DRIVER_CONTEXT_REQUIRED).')] })
  list(@Query(zodBody(MobileTransferListQueryDto)) query: MobileTransferListQueryDto, @CurrentUser() actor: ContextUser) {
    return this.transfers.list(actor, query);
  }
}
