import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { TripPatchDto } from './dto/mobile-fleet-ops.dto';
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
  @ApiOperation({ summary: 'P-03 — updates the driver-editable fields of the active trip.' })
  @ApiOkResponse({ schema: { example: { id: 'trip_1', shippingDocument: 'BOL-2201', trailerId: 'trl_1', notes: 'Left the yard early' } } })
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
