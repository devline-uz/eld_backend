import { Injectable, Logger } from '@nestjs/common';
import { isValidIanaTimezone } from '../../common/dto/timezone.dto';
import type { HosState } from '../hos/hos.types';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import { withEffectiveAdverse } from '../drivers/lib/adverse-driving';
import { LiveFleetRepository } from './live-fleet.repository';
import { compareUnitNumbers, toLiveFleetUnit, type LiveFleetResponse } from './live-fleet.mapper';

/** tz.md §19 — "live fleet 10 sec" cache. The web polls every 30 s (web/tz.md §6.4). */
export const LIVE_FLEET_CACHE_MS = 10_000;
/** §7.3 rule 5 — a device clock up to 10 min ahead is still "now"; beyond that it is ignored here. */
export const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
/** Window for the PC/YM lookup: matches the HOS engine's 9-day lookback plus today. */
const SPECIAL_LOOKBACK_MS = 10 * 24 * 60 * 60 * 1000;

@Injectable()
export class LiveFleetService {
  private readonly logger = new Logger(LiveFleetService.name);
  private cache: { at: number; value: Promise<LiveFleetResponse> } | null = null;

  constructor(
    private readonly repo: LiveFleetRepository,
    private readonly hos: HosRecalcService,
  ) {}

  /** Concurrent polls inside the TTL share one in-flight computation; a failure is never cached. */
  snapshot(now: Date = new Date()): Promise<LiveFleetResponse> {
    if (this.cache && now.getTime() - this.cache.at < LIVE_FLEET_CACHE_MS) return this.cache.value;
    const value = this.build(now);
    const entry = { at: now.getTime(), value };
    this.cache = entry;
    value.catch(() => {
      if (this.cache === entry) this.cache = null;
    });
    return value;
  }

  private async build(now: Date): Promise<LiveFleetResponse> {
    const until = new Date(now.getTime() + FUTURE_TOLERANCE_MS);
    const vehicles = await this.repo.findVehicles();
    const vehicleIds = vehicles.map((v) => v.id);
    const assigned = vehicles.flatMap((v) => (v.driver ? [v.driver] : []));
    // BUG-001 — the +2 h adverse extension only on a day it was invoked (§395.1(b)(1)).
    const drivers = withEffectiveAdverse(assigned, await this.repo.findAdverseInvokedToday(assigned, now));
    const driverIds = drivers.map((d) => d.id);

    const [telemetry, located, special, hosStates] = await Promise.all([
      this.repo.latestTelemetry(vehicleIds, until),
      this.repo.latestLocatedEvents(vehicleIds, until),
      this.repo.activeSpecialDriving(driverIds, new Date(now.getTime() - SPECIAL_LOOKBACK_MS), until),
      // BE-003 — a driver with an invalid stored timezone is skipped on its own (no clocks for that
      // unit) instead of the engine throwing and every unit losing its clocks.
      this.hos.computeCurrentStates(drivers.filter((d) => this.hosComputable(d)), now).catch((err: unknown) => {
        // The map is still useful without HOS clocks; never fail the whole fleet on the engine.
        this.logger.error({ err }, 'live fleet: HOS state computation failed — clocks omitted');
        return new Map<string, HosState>();
      }),
    ]);

    const items = vehicles
      .map((vehicle) => {
        const hos = vehicle.driver ? hosStates.get(vehicle.driver.id) : undefined;
        return toLiveFleetUnit({
          vehicle,
          driver: vehicle.driver,
          device: vehicle.device,
          telemetry: telemetry.get(vehicle.id) ?? null,
          located: located.get(vehicle.id) ?? null,
          hos: hos ?? null,
          special: vehicle.driver ? (special.get(vehicle.driver.id) ?? null) : null,
          now,
        });
      })
      .sort((a, b) => compareUnitNumbers(a.unitNumber, b.unitNumber));

    return { items, generatedAt: now.toISOString() };
  }

  private hosComputable(driver: { id: string; homeTerminalTimezone: string }): boolean {
    if (isValidIanaTimezone(driver.homeTerminalTimezone)) return true;
    this.logger.warn({ driverId: driver.id, timezone: driver.homeTerminalTimezone }, 'live fleet: invalid home-terminal timezone — HOS clocks omitted');
    return false;
  }
}
