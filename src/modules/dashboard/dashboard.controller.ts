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
 *   liveFleet: { items: LiveFleetUnit[], generatedAt: string, counts: { total, onDuty, moving, idle, offline } },
 *   violations: { items: Violation[], total: number },   // window=24h, status=OPEN, same shape as GET /violations
 *   unidentified: { total: number, totalDurationSec: number }, // status=PENDING
 *   notifications: { unreadCount: number },               // caller's own inbox
 *   carrier: { id: string, name: string, timezone: string | null },
 *   vehicles: { active: number, total: number },
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
    summary: 'One-call aggregate for the W-01 Fleet Dashboard: live fleet, 24h violations, pending unidentified driving, unread notification count, carrier basics, and vehicle counts.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        liveFleet: { items: [{ vehicleId: 'veh_1', unitNumber: '101', dutyStatus: 'DRIVING' }], generatedAt: '2026-09-16T15:39:10.000Z', counts: { total: 42, onDuty: 30, moving: 18, idle: 5, offline: 2 } },
        violations: { items: [{ id: 'vio_1', type: 'DRIVING_11', driverName: 'John Smith', unitNumber: '101' }], total: 3 },
        unidentified: { total: 2, totalDurationSec: 3600 },
        notifications: { unreadCount: 4 },
        carrier: { id: 'carrier', name: 'Universal Logistics Inc.', timezone: 'America/New_York' },
        vehicles: { active: 40, total: 45 },
        generatedAt: '2026-09-16T15:39:10.000Z',
      },
    },
  })
  @ApiStandardErrors()
  summary(@CurrentUser() actor: ContextUser) {
    return this.dashboard.summary(actor);
  }
}
