import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { TrailerSearchQueryDto, TripPatchDto } from './dto/mobile-fleet-ops.dto';
import { MobileTripService } from './mobile-trip.service';

/** mobile/tz.md §21.1 MB-5, screens M-05/S-05/P-03 — the driver's active trip. */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/trip')
export class MobileTripController {
  constructor(private readonly service: MobileTripService) {}

  @Get()
  @ApiOperation({ summary: 'M-05/S-05/P-03 — active (IN_PROGRESS, else next ASSIGNED) trip with stops[] and documents[]; null when none.' })
  @ApiOkResponse({ schema: { example: { id: 'trip_1', number: 'T-1042', status: 'IN_PROGRESS', stops: [], documents: [] } } })
  @ApiStandardErrors()
  get(@CurrentUser('id') driverId: string) {
    return this.service.getActive(driverId);
  }

  @Patch()
  @ApiOperation({
    summary: 'P-03 — updates the driver-editable fields of the active trip.',
    description:
      'MR-4. `shippingDocument`, `trailerNumber` and `notes` accept `null` or `""` to CLEAR the value. ' +
      '`trailerNumber:"BOBTAIL"` (case-insensitive) or `bobtail:true` means "no trailer" (200, trailerId cleared; combining it with a real trailer is 422). ' +
      'Optional arrays `shippingDocuments: string[]` / `trailerNumbers: string[]` (max 20) replace the lists and win over the single fields; ' +
      'the single fields mirror the first element. Every real trailer number must exist (422 TRAILER_NOT_FOUND). ' +
      'The response always carries `shippingDocument(s)`, `trailerNumber(s)`, `bobtail`.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'trip_1',
        shippingDocument: 'BOL-2201',
        shippingDocuments: ['BOL-2201', 'BOL-2202'],
        trailerId: 'trl_1',
        trailerNumber: 'TR-1',
        trailerNumbers: ['TR-1'],
        bobtail: false,
        notes: 'Left the yard early',
      },
    },
  })
  @ApiStandardErrors({
    errors: [
      apiError.notFound(ERROR_CODES.TRIP_NOT_FOUND, 'No active trip to update.'),
      apiError.unprocessable(ERROR_CODES.TRAILER_NOT_FOUND, 'No trailer with that number exists.'),
    ],
  })
  patch(@Body(zodBody(TripPatchDto)) dto: TripPatchDto, @CurrentUser('id') driverId: string) {
    return this.service.patch(driverId, dto);
  }
}

/** MR-8 — trailer picker on the trip screen (P-03). */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/trailers')
export class MobileTrailersController {
  constructor(private readonly service: MobileTripService) {}

  @Get()
  @ApiOperation({ summary: 'P-03 — the carrier\'s active (not deleted) trailers; `q` matches number or VIN, case-insensitive.' })
  @ApiQuery({ name: 'q', required: false, description: 'Substring of the trailer number / VIN.' })
  @ApiQuery({ name: 'limit', required: false, description: '1-200, default 50.' })
  @ApiOkResponse({ schema: { example: [{ id: 'trl_1', number: 'TR-1', plate: null }] } })
  @ApiStandardErrors()
  list(@Query(zodBody(TrailerSearchQueryDto)) query: TrailerSearchQueryDto) {
    return this.service.listTrailers(query.q, query.limit);
  }
}
