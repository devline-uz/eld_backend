import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { AssignCoachingDto, ScorecardQueryDto, SafetyEventListQueryDto, UpdateSafetyEventDto } from './dto/safety.dto';
import { SafetyService } from './safety.service';

/** TZ §11.5 / eld.docs/web §9 — "Safety" screen: harsh events, scoring, coaching. */
@FigmaScreen('web/safety')
@ApiTags('safety')
@ApiBearerAuth()
@Controller('safety')
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Get('events')
  @Perm('safety', 'READ')
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOperation({ summary: 'Lists harsh-driving events ("Events by type").' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'sfe_1', type: 'HARSH_BRAKING', severity: 3, status: 'NEW' }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors()
  listEvents(@Query(zodBody(SafetyEventListQueryDto)) query: SafetyEventListQueryDto) {
    return this.safety.listEvents(query);
  }

  @Patch('events/:id')
  @Perm('safety', 'FULL')
  @Audit({ object: 'SafetyEvent', action: 'UPDATE' })
  @ApiOperation({ summary: 'Marks a safety event REVIEWED/DISMISSED (short of full coaching).' })
  @ApiOkResponse({ schema: { example: { id: 'sfe_1', status: 'REVIEWED' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Safety event not found.')] })
  updateEvent(@Param('id') id: string, @Body(zodBody(UpdateSafetyEventDto)) dto: UpdateSafetyEventDto) {
    return this.safety.updateEvent(id, dto);
  }

  @Get('scorecard')
  @Perm('safety', 'READ')
  @ApiOperation({
    summary:
      'Fleet safety score and per-driver ranking ("Driver scorecard", below-70 flagged). D-133: returns the latest nightly-computed rolling 30-day period (or the one starting on `periodStart` / ending on `periodEnd`, YYYY-MM-DD). Drivers under `minMiles` have `score: null`, `rank: null`. `fleet.score` is the mile-weighted mean of scored drivers; `fleet.trend` and per-row `trend` compare with the previous period of the same length.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        periodStart: '2026-09-11',
        periodEnd: '2026-10-10',
        computedAt: '2026-10-11T10:30:02.000Z',
        minMiles: 100,
        fleet: { score: 88, previousScore: 85, trend: 3, scoredDrivers: 12, unscoredDrivers: 2, belowThresholdCount: 1, milesDriven: 48210 },
        items: [
          { id: 'dsc_1', driverId: 'drv_1', periodStart: '2026-09-11', periodEnd: '2026-10-10', score: 96, scored: true, harshCount: 1, speedingCount: 0, seatbeltCount: 0, milesDriven: 5210, violationCount: 0, rank: 1, previousScore: 92, trend: 4, computedAt: '2026-10-11T10:30:02.000Z' },
          { id: 'dsc_2', driverId: 'drv_2', periodStart: '2026-09-11', periodEnd: '2026-10-10', score: null, scored: false, harshCount: 0, speedingCount: 0, seatbeltCount: 0, milesDriven: 42, violationCount: 0, rank: null, previousScore: null, trend: null, computedAt: '2026-10-11T10:30:02.000Z' },
        ],
      },
    },
  })
  @ApiStandardErrors()
  scorecard(@Query(zodBody(ScorecardQueryDto)) query: ScorecardQueryDto) {
    return this.safety.scorecard(query);
  }

  @Post('coaching')
  @Perm('safety', 'FULL')
  @Audit({ object: 'SafetyEvent', action: 'COACH' })
  @ApiOperation({ summary: '"Assign coaching" — closes a safety event as COACHED with a note. B-43: pass `driverId` instead of `eventId` to assign at the driver level (coaches that driver\'s most recent open event).' })
  @ApiOkResponse({ schema: { example: { id: 'sfe_1', status: 'COACHED', coachedById: 'usr_1' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Safety event not found (or no open event for the given driverId).')] })
  coach(@Body(zodBody(AssignCoachingDto)) dto: AssignCoachingDto, @CurrentUser() actor: ContextUser) {
    return this.safety.coach(dto, actor.id);
  }
}
