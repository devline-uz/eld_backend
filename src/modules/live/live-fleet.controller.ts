import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { LiveFleetQueryDto } from './dto/live-fleet.dto';
import { toLiveFleetListUnit, type LiveFleetUnit } from './live-fleet.mapper';
import { LiveFleetService, serverTiming, type LiveFleetRead } from './live-fleet.service';

const UNIT_EXAMPLE = {
  vehicleId: 'veh_1', unitNumber: '101', driverId: 'drv_1', driverName: 'John Smith',
  driverPhone: '+1 334 765 4888', dutyStatus: 'ON_DUTY', speedMph: 0, headingDeg: 274,
  odometerMi: 993589, lat: 38.99, lon: -84.63, locationLabel: '0.64 mi N of Florence, KY',
  lastSeenAt: '2026-09-12T15:39:00.000Z', driveRemainingSec: 0,
  shiftEndsAt: '2026-09-12T15:59:34.000Z', eldSerial: 'PT30_A86E', bleState: 'CONNECTED',
  driverDutyStatus: 'DRIVING', recordStatus: 'ACTIVE', connectivity: 'ONLINE', isStale: false, staleSince: null,
};

/** CODE-053 — driver phone numbers are `drivers` data (same rule as `/dashboard/summary`). */
function canSeePhone(actor?: ContextUser): boolean {
  const level = actor?.permissions?.drivers ?? 'NONE';
  return level === 'READ' || level === 'FULL';
}

/** LV-02 — `Server-Timing` on both live-fleet reads: cache state, snapshot age, build phases. */
function setTiming(res: Response | undefined, read: LiveFleetRead): void {
  res?.setHeader('Server-Timing', serverTiming(read));
}

/**
 * web/tz.md §20 B-3 — W-01 map preview and W-02 Live Fleet. Gated by `liveFleet` (READ for
 * every role, tz.md §6.4). The fleet is single-tenant (tz.md §27.3), so the carrier scope is the
 * whole `Vehicle` table.
 */
@FigmaScreen('web/live-fleet', 'web/fleet-dashboard')
@ApiTags('live')
@ApiBearerAuth()
@Controller('live')
export class LiveFleetController {
  constructor(private readonly live: LiveFleetService) {}

  @Get('fleet')
  @Perm('liveFleet', 'READ')
  @ApiOperation({
    summary: 'Current snapshot of every unit: last known position, speed, driver, duty status, HOS clocks, ELD link.',
  })
  @ApiQuery({
    name: 'view',
    required: false,
    enum: ['full', 'list'],
    description:
      "'full' (default) — every field below. 'list' — the web's slim rows: driverPhone, odometerMi, driveRemainingSec, shiftEndsAt and eldSerial are omitted (the selected-unit card reads them from GET /live/fleet/{vehicleId}).",
  })
  @ApiOkResponse({
    description:
      "UI-003/UI-004 (additive): recordStatus 'ACTIVE'|'INACTIVE'|'OUT_OF_SERVICE' (stored Vehicle.status); connectivity 'NO_DEVICE'|'ELD_OFFLINE'|'ONLINE' (ELD_OFFLINE = silent > 30 min); isStale boolean (duty status past its plausibility cap, or a DRIVING/ON_DUTY unit whose ELD went silent); staleSince ISO string|null. dutyStatus semantics: a stale assigned D/ON unit reads ELD_OFFLINE; an OUT_OF_SERVICE/INACTIVE record reads INACTIVE. speedMph is null when telemetry is older than 30 min. QA LIVE-002 (additive): driverDutyStatus 'DRIVING'|'ON_DUTY'|'SLEEPER'|'OFF_DUTY'|null — the assigned driver's own HOS status (Drivers roster vocabulary), last known even when the unit reads ELD_OFFLINE/INACTIVE; null with no driver or no HOS state.",
    schema: { example: { items: [UNIT_EXAMPLE], generatedAt: '2026-09-12T15:39:10.000Z' } },
  })
  @ApiStandardErrors()
  async fleet(
    @CurrentUser() actor?: ContextUser,
    @Query(zodBody(LiveFleetQueryDto)) query: LiveFleetQueryDto = { view: 'full' },
    @Res({ passthrough: true }) res?: Response,
  ) {
    const read = await this.live.read();
    setTiming(res, read);
    const { snapshot } = read;
    // The slim web list carries no phone at all, so there is nothing to redact.
    if (query.view === 'list') return { ...snapshot, items: snapshot.items.map(toLiveFleetListUnit) };
    if (canSeePhone(actor)) return snapshot;
    return { ...snapshot, items: snapshot.items.map((u) => ({ ...u, driverPhone: null })) };
  }

  /**
   * W-02 selected-unit detail card — the full row (HOS clocks, odometer, ELD serial, phone) for
   * ONE unit, polled only while a unit is selected. Same guard, scope and cached snapshot as the
   * list; a deleted or unknown unit is a 404.
   */
  @Get('fleet/:vehicleId')
  @Perm('liveFleet', 'READ')
  @ApiOperation({ summary: 'One unit of the live snapshot, every field (the Live Fleet selected-unit card).' })
  @ApiOkResponse({
    description: 'Same row as one GET /live/fleet item (view=full); driverPhone is null without drivers READ (CODE-053).',
    schema: { example: UNIT_EXAMPLE },
  })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.')] })
  async unit(
    @Param('vehicleId') vehicleId: string,
    @CurrentUser() actor?: ContextUser,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<LiveFleetUnit> {
    const read = await this.live.read();
    setTiming(res, read);
    const unit = this.live.unitOf(read.snapshot, vehicleId);
    return canSeePhone(actor) ? unit : { ...unit, driverPhone: null };
  }
}
