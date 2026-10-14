import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import { MobileCreateTransferDto, MobileTransferListQueryDto } from './dto/mobile-transfers.dto';
import { MobileTransferCreatedResponse, MobileTransferListResponse } from './dto/mobile-transfers.responses';
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
      'The row is returned as it stands right after generation (`status = QUEUED`); the worker moves it to TEST_ONLY / SENT / ACCEPTED / REJECTED / FAILED and fills `referenceId` + `sentAt`. Poll `GET /mobile/transfers` for the receipt (S-10). MB-18 — an offline roadside-inspection transfer is queued by the app and replayed on reconnect: send a `clientId` (idempotent — a replay returns the FIRST result, no second file or send; a clientId used by another operation is 409) and optionally `requestedAt` (device time of the request, echoed back). 4xx is final; retry only on 5xx/network. RANGE (B-172): the range is counted in home-terminal-timezone days, at most 8 (inclusive). `rangeStart`/`rangeEnd` may be `YYYY-MM-DD` (taken as that home-terminal RODS day) or an ISO instant (mapped to the home-terminal day it falls on); the file covers home-terminal midnight of the first day to home-terminal midnight after the last day (DST-aware). The response `rangeStart`/`rangeEnd` are those home-terminal day keys at T00:00:00.000Z (date-only columns), not instants.',
  })
  @ApiEnvelopeResponse(MobileTransferCreatedResponse, {
    status: 201,
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
      rangeStart: '2026-09-03T00:00:00.000Z',
      rangeEnd: '2026-09-10T00:00:00.000Z',
      warnings: ['ERODS_TEST_MODE'],
      counts: { header: 9, events: 42 },
      clientId: '0b9d6f5e-0000-4000-8000-000000000002',
      requestedAt: '2026-09-10T15:40:00.000Z',
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.forbidden('Driver token required (DRIVER_CONTEXT_REQUIRED).'),
      apiError.notFound(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.'),
      apiError.unprocessableOneOf([
        { code: ERROR_CODES.RANGE_TOO_LARGE, message: "Requested range is 9 days; §395.24 / Appendix A allows at most 8. The range is counted in home-terminal-timezone days (midnight to midnight in the driver's homeTerminalTimezone), at most 8 inclusive", details: { findings: [{ code: 'RANGE_TOO_LARGE', level: 'error', details: { days: 9, max: 8 } }] } },
        { code: ERROR_CODES.INVALID_TRANSFER_RECIPIENT, message: 'EMAIL transfer recipient must be an @fmcsa.dot.gov address (§10.4)' },
        { code: ERROR_CODES.VALIDATION_FAILED, message: 'Request validation failed, e.g. requestedAt more than 5 minutes in the future, EMAIL without recipient, outputFileComment over 60 chars, or an invalid date' },
        { code: ERROR_CODES.OUTPUT_FILE_INVALID, message: 'The generated output file does not conform to §395 Appendix A and was not stored' },
      ]),
    ],
  })
  create(@Body(zodBody(MobileCreateTransferDto)) dto: MobileCreateTransferDto, @CurrentUser() actor: ContextUser) {
    return this.transfers.create(actor, dto);
  }

  @Get()
  @ApiOperation({ summary: "The driver's own most recent transfers (receipts for S-10 / M-27 `Last transfer`)." })
  @ApiEnvelopeResponse(MobileTransferListResponse, {
    example: {
      items: [
        { id: 'trf_1', method: 'WEB_SERVICES', status: 'TEST_ONLY', erodsMode: 'TEST', referenceId: 'ERODS-TEST-26-0910-4821', sentAt: '2026-09-10T15:44:02.000Z', createdAt: '2026-09-10T15:44:00.000Z', fileName: 'SMITH38018.csv', outputFileComment: 'ROADSIDE INSPECTION 2026-09-10', rangeStart: '2026-09-03T00:00:00.000Z', rangeEnd: '2026-09-10T00:00:00.000Z' },
      ],
      total: 1,
      limit: 5,
    },
  })
  @ApiStandardErrors({ errors: [apiError.forbidden('Driver token required (DRIVER_CONTEXT_REQUIRED).')] })
  list(@Query(zodBody(MobileTransferListQueryDto)) query: MobileTransferListQueryDto, @CurrentUser() actor: ContextUser) {
    return this.transfers.list(actor, query);
  }
}
