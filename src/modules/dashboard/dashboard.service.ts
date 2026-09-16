import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { CarrierService } from '../carrier/carrier.service';
import type { LiveDutyStatus } from '../live/live-fleet.mapper';
import { LiveFleetService } from '../live/live-fleet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UnidentifiedService } from '../unidentified/unidentified.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { ViolationsService } from '../violations/violations.service';

const DUTY_ON_STATUSES: LiveDutyStatus[] = ['DRIVING', 'ON_DUTY', 'SLEEPER'];

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
    private readonly violations: ViolationsService,
    private readonly unidentified: UnidentifiedService,
    private readonly notifications: NotificationsService,
    private readonly carrier: CarrierService,
    private readonly vehicles: VehiclesService,
  ) {}

  async summary(actor: ContextUser, now: Date = new Date()) {
    const [fleet, violationsPage, unidentifiedPage, unread, carrierProfile, activeVehicles, allVehicles] = await Promise.all([
      this.liveFleet.snapshot(now),
      this.violations.list({ window: '24h', status: 'OPEN', page: 1, limit: 25 }, now),
      this.unidentified.list({ status: 'PENDING', page: 1, limit: 25 }),
      this.notifications.list(actor, { page: 1, limit: 1, unreadOnly: true }),
      this.carrier.get(),
      this.vehicles.list({ page: 1, limit: 1, status: 'ACTIVE' }),
      this.vehicles.list({ page: 1, limit: 1 }),
    ]);

    const units = fleet.items;
    const counts = {
      total: units.length,
      onDuty: units.filter((u) => DUTY_ON_STATUSES.includes(u.dutyStatus)).length,
      moving: units.filter((u) => u.dutyStatus === 'DRIVING').length,
      idle: units.filter((u) => u.dutyStatus === 'IDLE').length,
      offline: units.filter((u) => u.dutyStatus === 'ELD_OFFLINE').length,
    };

    return {
      liveFleet: { items: units, generatedAt: fleet.generatedAt, counts },
      violations: { items: violationsPage.items, total: violationsPage.total },
      unidentified: {
        total: unidentifiedPage.total,
        totalDurationSec: unidentifiedPage.items.reduce((sum, s) => sum + (s.durationSec ?? 0), 0),
      },
      notifications: { unreadCount: unread.total },
      carrier: { id: carrierProfile.id, name: carrierProfile.name, timezone: carrierProfile.timezone },
      vehicles: { active: activeVehicles.total, total: allVehicles.total },
      generatedAt: now.toISOString(),
    };
  }
}
