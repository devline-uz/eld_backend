import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { TrailerSearchQueryDto, TripPatchDto, TripQueryDto } from './dto/mobile-fleet-ops.dto';
import { MobileTripService } from './mobile-trip.service';

/** mobile/tz.md §21.1 MB-5, screens M-05/S-05/P-03 — the driver's active trip. */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/trip')
export class MobileTripController {
  constructor(private readonly service: MobileTripService) {}

  @Get()
  @ApiOperation({
    summary: 'M-05/S-05/P-03 — active (IN_PROGRESS, else next ASSIGNED) trip with stops[] and documents[]; with no trip, the day details (D-129).',
    description:
      'With an active trip the body is the trip (`source:"TRIP"`). With NO active trip (D-129, M-09/M-12) the body is the ' +
      'driver\'s day details for `date` (home-terminal RODS day, default today): `source:"DAY_DETAILS"`, `id:null`, `trip:null`, ' +
      '`logDate`, the same `shippingDocument(s)` / `trailerNumber(s)` / `trailerId` / `bobtail` / `notes` fields, `stops:[]`, `documents[]`. ' +
      'Never null any more — empty lists when nothing is stored.',
  })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD home-terminal day; only used when there is no active trip.' })
  @ApiOkResponse({
    schema: {
      example: {
        source: 'DAY_DETAILS',
        id: null,
        trip: null,
        logDate: '2026-10-08',
        shippingDocument: 'BOL-2201',
        shippingDocuments: ['BOL-2201'],
        trailerId: null,
        trailerNumber: 'X53-1188',
        trailerNumbers: ['X53-1188'],
        bobtail: false,
        notes: null,
        updatedAt: '2026-10-08T14:02:11.000Z',
        stops: [],
        documents: [],
      },
    },
    description: 'Example shows the no-trip (`DAY_DETAILS`) body; with a trip it is the trip shape with `source:"TRIP"` (see PATCH example).',
  })
  @ApiStandardErrors()
  get(@CurrentUser('id') driverId: string, @Query(zodBody(TripQueryDto)) query: TripQueryDto) {
    return this.service.getActive(driverId, query.date);
  }

  @Patch()
  @ApiOperation({
    summary: 'P-03 — updates the driver-editable fields of the active trip; with no trip, the day details (D-129).',
    description:
      'MR-4. `shippingDocument`, `trailerNumber` and `notes` accept `null` or `""` to CLEAR the value. ' +
      '`trailerNumber:"BOBTAIL"` (case-insensitive) or `bobtail:true` means "no trailer" (200, trailerId cleared; combining it with a real trailer is 422). ' +
      'Optional arrays `shippingDocuments: string[]` / `trailerNumbers: string[]` (max 20) replace the lists and win over the single fields; ' +
      'the single fields mirror the first element. The response always carries `shippingDocument(s)`, `trailerNumber(s)`, `bobtail`. ' +
      'D-129: trailer numbers are FREE TEXT (no 422 TRAILER_NOT_FOUND) — trimmed, upper-cased, each 1-10 chars `[A-Z0-9-]` and all of them ' +
      'joined by spaces at most 32 chars (49 CFR 395 Appendix A 7.42); `trailerId` links the first one matching an ACTIVE carrier trailer, else null. ' +
      'Shipping documents are at most 40 chars each (7.39). With NO active trip the fields are stored for the RODS day `logDate` ' +
      '(YYYY-MM-DD home-terminal day, default today, at most 30 days back) and the response is the day-details shape (`source:"DAY_DETAILS"`, `id:null`); ' +
      'a change on a certified day drops its certification (re-certification required).',
  })
  @ApiOkResponse({
    schema: {
      example: {
        source: 'TRIP',
        id: 'trip_1',
        shippingDocument: 'BOL-2201',
        shippingDocuments: ['BOL-2201', 'BOL-2202'],
        trailerId: 'trl_1',
        trailerNumber: 'TR-1',
        trailerNumbers: ['TR-1', 'X53-1188'],
        bobtail: false,
        notes: 'Left the yard early',
      },
    },
  })
  @ApiStandardErrors({
    errors: [apiError.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Bad trailer number format, BOBTAIL mixed with a trailer, or logDate out of range.')],
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
