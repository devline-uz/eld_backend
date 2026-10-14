import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Perm } from '../../common/decorators/perm.decorator';
import { ApiStandardErrors } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';
import type { ContextUser } from '../../core/context/request-context';
import { DashboardService } from './dashboard.service';

/**
 * Perf plan item 3 (web perf audit, 2026-09-16) — `GET /api/dashboard/summary` replaces the
 * 6 requests W-01 Fleet Dashboard fires on open with one. Gated by `dashboard` READ (§6.4 —
 * READ for every role). Response shape (mirrors what each individual endpoint already returns,
 * trimmed to what `DashboardPage.tsx` reads):
 *
 * ```
 * {
 *   liveFleet: { items: LiveFleetUnit[], generatedAt: string, counts: { total, onDuty, moving, idle, offline, driverDuty } },
 *   // onDuty / driverDuty: assigned drivers by their HOS status (same definition as the Drivers list);
 *   // offline: units whose paired ELD has been silent > 30 min (connectivity ELD_OFFLINE).
 *   violations: { items: Violation[], total: number },   // status=OPEN (any day), same shape as GET /violations
 *   unidentified: { total: number, totalDurationSec: number,      // status=PENDING
 *                   awaitingDriver: number, awaitingDriverDurationSec: number }, // PENDING_CONFIRMATION
 *   notifications: { unreadCount: number },               // caller's own inbox
 *   carrier: { id: string, name: string, timezone: string | null },
 *   vehicles: { active: number, total: number, inactive: number, outOfService: number },
 *   generatedAt: string,
 * }
 * ```
 */
@FigmaScreen('web/fleet-dashboard')
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @Perm('dashboard', 'READ')
  @ApiOperation({
    summary: 'One-call aggregate for the W-01 Fleet Dashboard: live fleet, open violations, pending unidentified driving, unread notification count, carrier basics, and vehicle counts.',
  })
  @ApiOkResponse({
    description:
      "UI-003/UI-004 (additive): recordStatus 'ACTIVE'|'INACTIVE'|'OUT_OF_SERVICE' (stored Vehicle.status); connectivity 'NO_DEVICE'|'ELD_OFFLINE'|'ONLINE' (ELD_OFFLINE = silent > 30 min); isStale boolean (duty status past its plausibility cap, or a DRIVING/ON_DUTY unit whose ELD went silent); staleSince ISO string|null. dutyStatus semantics: a stale assigned D/ON unit reads ELD_OFFLINE; an OUT_OF_SERVICE/INACTIVE record reads INACTIVE. speedMph is null when telemetry is older than 30 min. vehicles.inactive / vehicles.outOfService: fleet-wide record-status counts. liveFleet.counts.moving counts DRIVING units that are not stale. QA LIVE-002: liveFleet.counts.onDuty = assigned drivers whose HOS status (driverDutyStatus) is DRIVING/ON_DUTY/SLEEPER (the Drivers list definition); liveFleet.counts.driverDuty = assigned drivers per status + UNKNOWN, summing to assigned. QA LIVE-011: liveFleet.counts.offline = units with connectivity ELD_OFFLINE (paired ELD silent > 30 min).",
    schema: {
      example: {
        liveFleet: { items: [{ vehicleId: 'veh_1', unitNumber: '101', dutyStatus: 'DRIVING', driverDutyStatus: 'DRIVING', recordStatus: 'ACTIVE', connectivity: 'ONLINE', isStale: false, staleSince: null }], generatedAt: '2026-09-16T15:39:10.000Z', counts: { total: 42, onDuty: 30, moving: 18, idle: 5, offline: 2, driverDuty: { assigned: 36, DRIVING: 18, ON_DUTY: 10, SLEEPER: 2, OFF_DUTY: 6, UNKNOWN: 0 } } },
        violations: { items: [{ id: 'vio_1', type: 'DRIVING_11', driverName: 'John Smith', unitNumber: '101' }], total: 3 },
        unidentified: { total: 2, totalDurationSec: 3600, awaitingDriver: 1, awaitingDriverDurationSec: 900 },
        notifications: { unreadCount: 4 },
        carrier: { id: 'carrier', name: 'Universal Logistics Inc.', timezone: 'America/New_York' },
        vehicles: { active: 40, total: 45, inactive: 3, outOfService: 2 },
        generatedAt: '2026-09-16T15:39:10.000Z',
      },
    },
  })
  @ApiStandardErrors()
  summary(@CurrentUser() actor: ContextUser) {
    return this.dashboard.summary(actor);
  }
}
