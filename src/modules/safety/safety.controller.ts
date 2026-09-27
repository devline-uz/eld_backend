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
  @ApiOperation({ summary: 'Fleet safety score and per-driver ranking ("Driver scorecard", below-70 flagged). B-44: each row includes previousScore/trend vs. the prior period of the same length.' })
  @ApiOkResponse({ schema: { example: { items: [{ driverId: 'drv_1', score: 68, harshCount: 4, rank: 1, previousScore: 74, trend: -6 }], periodStart: '2026-08-12', periodEnd: '2026-09-11' } } })
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
