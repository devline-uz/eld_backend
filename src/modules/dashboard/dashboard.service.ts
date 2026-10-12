import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { CarrierService } from '../carrier/carrier.service';
import type { LiveDutyStatus } from '../live/live-fleet.mapper';
import { LiveFleetService } from '../live/live-fleet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UnidentifiedService } from '../unidentified/unidentified.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ActiveViolationsService } from '../violations/active-violations.service';

const DUTY_ON_STATUSES: LiveDutyStatus[] = ['DRIVING', 'ON_DUTY', 'SLEEPER'];

type Section = 'liveFleet' | 'drivers' | 'hos' | 'vehicles';

/** BE-009 — READ (or FULL) on `key`, judged exactly like `PermissionGuard` (missing = NONE). */
function canRead(actor: ContextUser, key: Section): boolean {
  const level = actor.permissions?.[key] ?? 'NONE';
  return level === 'READ' || level === 'FULL';
}

const EMPTY_PAGE = { items: [] as never[], total: 0 };

/**
 * Perf plan item 3 — the W-01 Fleet Dashboard opens by firing 6 separate requests
 * (`/live/fleet`, `/violations?window=24h`, `/unidentified?status=PENDING`,
 * `/notifications?unreadOnly=true&limit=1`, `/carrier`, two `/vehicles?...&limit=1` calls).
 * This service answers all of them in one round trip by running the same sub-queries the
 * individual controllers already run (`Promise.all`, no duplicated query logic) and shaping
 * the result the way `DashboardPage.tsx` consumes each piece today.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly liveFleet: LiveFleetService,
    private readonly violations: ActiveViolationsService,
    private readonly unidentified: UnidentifiedService,
    private readonly notifications: NotificationsService,
    private readonly carrier: CarrierService,
    private readonly vehicles: VehiclesService,
  ) {}

  /**
   * BE-009 — `dashboard` READ alone no longer reveals what the dedicated screens guard: each
   * section is filled only when the caller could read its own endpoint (`liveFleet` for the map,
   * `hos` for violations / unidentified driving, `vehicles` for the counts); otherwise it keeps its
   * shape but is empty. Driver phone numbers additionally need `drivers` READ. Every default role
   * has all four, so their dashboards are unchanged.
   */
  async summary(actor: ContextUser, now: Date = new Date()) {
    const can = {
      liveFleet: canRead(actor, 'liveFleet'),
      drivers: canRead(actor, 'drivers'),
      hos: canRead(actor, 'hos'),
      vehicles: canRead(actor, 'vehicles'),
    };
    const [fleet, violationsPage, unidentifiedPage, unread, carrierProfile, activeVehicles, allVehicles] = await Promise.all([
      can.liveFleet ? this.liveFleet.snapshot(now) : { items: [], generatedAt: now.toISOString() },
      // One definition of "violation" across the panel: an OPEN `HosViolation` row, whatever day
      // it was filed on — the same rows the Drivers roster counts (`openViolations`) and the
      // driver log lists. A 24 h window here made the KPI read 0 while the roster said "1 with
      // active violations" for a violation filed two days earlier and still unresolved.
      // BUG-003 — read through `ActiveViolationsService`, the single web definition.
      can.hos ? this.violations.list({ status: 'OPEN', page: 1, limit: 25 }, now) : EMPTY_PAGE,
      can.hos ? this.unidentified.list({ status: 'PENDING', page: 1, limit: 25 }) : EMPTY_PAGE,
      this.notifications.list(actor, { page: 1, limit: 1, unreadOnly: true }),
      this.carrier.get(),
      can.vehicles ? this.vehicles.list({ page: 1, limit: 1, status: 'ACTIVE' }) : EMPTY_PAGE,
      can.vehicles ? this.vehicles.list({ page: 1, limit: 1 }) : EMPTY_PAGE,
    ]);

    const units = can.drivers ? fleet.items : fleet.items.map((u) => ({ ...u, driverPhone: null }));
    const counts = {
      total: units.length,
      onDuty: units.filter((u) => DUTY_ON_STATUSES.includes(u.dutyStatus)).length,
      // UI-003 — a stale / silent unit is never "moving" (the mapper already reads it ELD_OFFLINE).
      moving: units.filter((u) => u.dutyStatus === 'DRIVING' && !u.isStale).length,
      idle: units.filter((u) => u.dutyStatus === 'IDLE').length,
      offline: units.filter((u) => u.dutyStatus === 'ELD_OFFLINE').length,
    };

    return {
      liveFleet: { items: units, generatedAt: fleet.generatedAt, counts },
      violations: { items: violationsPage.items, total: violationsPage.total },
      unidentified: {
        total: unidentifiedPage.total,
        totalDurationSec: (unidentifiedPage.items as Array<{ durationSec?: number | null }>).reduce((sum, s) => sum + (s.durationSec ?? 0), 0),
      },
      notifications: { unreadCount: unread.total },
      carrier: { id: carrierProfile.id, name: carrierProfile.name, timezone: carrierProfile.timezone },
      // UI-004 — inactive / outOfService: fleet-wide record-status counts (additive).
      vehicles: {
        active: activeVehicles.total,
        total: allVehicles.total,
        inactive: 'statusCounts' in allVehicles ? allVehicles.statusCounts.INACTIVE : 0,
        outOfService: 'statusCounts' in allVehicles ? allVehicles.statusCounts.OUT_OF_SERVICE : 0,
      },
      generatedAt: now.toISOString(),
    };
  }
}
