import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { CarrierService } from '../carrier/carrier.service';
import type { DriverDutyStatus, LiveFleetUnit } from '../live/live-fleet.mapper';
import { LiveFleetService } from '../live/live-fleet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UnidentifiedService } from '../unidentified/unidentified.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ActiveViolationsService } from '../violations/active-violations.service';

/**
 * QA LIVE-002 / CODE-020 — "on duty" exactly as the Drivers list counts it (`useDriverRosterCounts`:
 * every driver whose HOS duty status is not OFF_DUTY — Driving, On-duty and Sleeper). Read from the
 * driver's own HOS status (`driverDutyStatus`), never from the unit's live marker: an ELD-offline,
 * stale, out-of-service or idle / yard-move unit still has a driver in a known duty status.
 */
const DRIVER_ON_DUTY_STATUSES: DriverDutyStatus[] = ['DRIVING', 'ON_DUTY', 'SLEEPER'];

/** Breakdown of the drivers assigned to a unit by HOS duty status; slices always sum to `assigned`. */
export interface DriverDutyCounts {
  assigned: number;
  DRIVING: number;
  ON_DUTY: number;
  SLEEPER: number;
  OFF_DUTY: number;
  /** Driver assigned but their HOS state could not be computed. */
  UNKNOWN: number;
}

export function countDriverDuty(units: Array<Pick<LiveFleetUnit, 'driverId' | 'driverDutyStatus'>>): DriverDutyCounts {
  const counts: DriverDutyCounts = { assigned: 0, DRIVING: 0, ON_DUTY: 0, SLEEPER: 0, OFF_DUTY: 0, UNKNOWN: 0 };
  for (const unit of units) {
    if (!unit.driverId) continue; // a unit without a driver is not a driver
    counts.assigned += 1;
    counts[unit.driverDutyStatus ?? 'UNKNOWN'] += 1;
  }
  return counts;
}

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
    const driverDuty = countDriverDuty(units);
    const counts = {
      total: units.length,
      // QA LIVE-002 — same definition and source as the Drivers list "On duty" chip.
      onDuty: DRIVER_ON_DUTY_STATUSES.reduce((sum, status) => sum + driverDuty[status], 0),
      // UI-003 — a stale / silent unit is never "moving" (the mapper already reads it ELD_OFFLINE).
      moving: units.filter((u) => u.dutyStatus === 'DRIVING' && !u.isStale).length,
      idle: units.filter((u) => u.dutyStatus === 'IDLE').length,
      // QA LIVE-011 — units whose paired ELD has been silent > 30 min (`connectivity`, the same
      // `ELD_OFFLINE_AFTER_MS` line Settings › ELD devices uses), whatever the driver's status or the
      // unit's record status. It used to count only the units whose duty marker read ELD_OFFLINE.
      offline: units.filter((u) => u.connectivity === 'ELD_OFFLINE').length,
      // QA LIVE-002 — the duty donut's slices (assigned drivers by HOS status, + UNKNOWN).
      driverDuty,
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
