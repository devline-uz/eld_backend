import { Injectable, Logger } from '@nestjs/common';
import { isValidIanaTimezone } from '../../common/dto/timezone.dto';
import type { HosState } from '../hos/hos.types';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import { withEffectiveAdverse } from '../drivers/lib/adverse-driving';
import { LiveFleetRepository } from './live-fleet.repository';
import { AppException, ERROR_CODES } from '../../common/errors';
import { compareUnitNumbers, toLiveFleetUnit, type LiveFleetResponse, type LiveFleetUnit } from './live-fleet.mapper';

/**
 * tz.md §19 — "live fleet 10 sec" cache. The web polls every 30 s (web/tz.md §6.4). A snapshot is
 * FRESH for this long after its build COMPLETED (LV-02: it used to be stamped with the build's
 * start, so a build slower than 10 s was already expired when it landed and was never reused).
 */
export const LIVE_FLEET_CACHE_MS = 10_000;
/**
 * LV-02 — stale-while-revalidate bound. Past `LIVE_FLEET_CACHE_MS` and up to this age a request is
 * answered from the previous snapshot at once while ONE rebuild runs in the background; past it a
 * request waits for a fresh build (positions older than a minute are not served as "live").
 */
export const LIVE_FLEET_MAX_STALE_MS = 60_000;
/** LV-02 — a build slower than this is logged at warn level with its phase breakdown. */
export const LIVE_FLEET_SLOW_BUILD_MS = 2_000;
/** §7.3 rule 5 — a device clock up to 10 min ahead is still "now"; beyond that it is ignored here. */
export const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
/** Window for the PC/YM lookup: matches the HOS engine's 9-day lookback plus today. */
const SPECIAL_LOOKBACK_MS = 10 * 24 * 60 * 60 * 1000;

/** Duration (ms) of each phase of one build, in the order they started; `total` is the whole build. */
export type LiveFleetPhases = Record<string, number>;

/** How a read was answered: from a fresh snapshot, from a stale one (rebuild started), or by waiting for a build. */
export type LiveFleetCacheState = 'fresh' | 'stale' | 'miss';

export interface LiveFleetRead {
  snapshot: LiveFleetResponse;
  cache: LiveFleetCacheState;
  /** Age of the served snapshot, measured from its build's completion. */
  ageMs: number;
  /** Phase timings of the build that produced the served snapshot. */
  phases: LiveFleetPhases;
  /** Units covered by the latest-row probe passes of that build (e.g. `located.fallback`). */
  units: Record<string, number>;
}

interface Built {
  value: LiveFleetResponse;
  phases: LiveFleetPhases;
  units: Record<string, number>;
  /** Completion instant on the caller's clock (`now` of the build + its measured duration). */
  completedAt: number;
}

@Injectable()
export class LiveFleetService {
  private readonly logger = new Logger(LiveFleetService.name);
  /** The newest snapshot that finished building. A failed build never replaces it. */
  private latest: Built | null = null;
  /** The single build in flight, shared by every caller that needs to wait for it. */
  private inflight: Promise<Built> | null = null;

  constructor(
    private readonly repo: LiveFleetRepository,
    private readonly hos: HosRecalcService,
  ) {}

  /** The current fleet snapshot (see `read`). */
  async snapshot(now: Date = new Date()): Promise<LiveFleetResponse> {
    return (await this.read(now)).snapshot;
  }

  /**
   * LV-02 — stale-while-revalidate over one shared build:
   *  - snapshot younger than `LIVE_FLEET_CACHE_MS` (since it completed) → returned as is;
   *  - younger than `LIVE_FLEET_MAX_STALE_MS` → returned at once, and a background rebuild is
   *    started unless one is already running;
   *  - none, or older → the caller waits for the (shared) build.
   * A failed build is never cached: the previous snapshot stays (until it is too stale) and the
   * next read tries again. `generatedAt` is always the instant the served snapshot was computed as of.
   */
  async read(now: Date = new Date()): Promise<LiveFleetRead> {
    const latest = this.latest;
    const age = latest ? now.getTime() - latest.completedAt : Infinity;
    if (latest && age < LIVE_FLEET_CACHE_MS) return this.served(latest, 'fresh', now);
    if (latest && age < LIVE_FLEET_MAX_STALE_MS) {
      this.refresh(now).catch(() => undefined); // logged in `refresh`; the stale snapshot is served
      return this.served(latest, 'stale', now);
    }
    return this.served(await this.refresh(now), 'miss', now);
  }

  /**
   * `GET /live/fleet/:vehicleId` — one unit's full row, read from the same cached snapshot as the
   * list (so a list poll and a detail poll inside the TTL cost one computation, and both always
   * agree). A deleted or unknown unit is a 404, exactly as the list leaves it out.
   */
  async unit(vehicleId: string, now: Date = new Date()): Promise<LiveFleetUnit> {
    return this.unitOf((await this.read(now)).snapshot, vehicleId);
  }

  /** The row of `vehicleId` in `snapshot`, or the VEHICLE_NOT_FOUND 404. */
  unitOf(snapshot: LiveFleetResponse, vehicleId: string): LiveFleetUnit {
    const unit = snapshot.items.find((u) => u.vehicleId === vehicleId);
    if (!unit) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404);
    return unit;
  }

  private served(built: Built, cache: LiveFleetCacheState, now: Date): LiveFleetRead {
    return { snapshot: built.value, cache, ageMs: Math.max(0, Math.round(now.getTime() - built.completedAt)), phases: built.phases, units: built.units };
  }

  /** Starts the build unless one is in flight; publishes it as `latest` only on success. */
  private refresh(now: Date): Promise<Built> {
    if (this.inflight) return this.inflight;
    const started = performance.now();
    const run = this.build(now).then(
      ({ value, phases, units }) => {
        const completedAt = now.getTime() + (performance.now() - started);
        const built: Built = { value, phases, units, completedAt };
        // A slow build must not overwrite a newer one (cannot happen with one in flight, but cheap).
        if (!this.latest || this.latest.completedAt <= completedAt) this.latest = built;
        return built;
      },
      (err: unknown) => {
        this.logger.error({ err, ms: Math.round(performance.now() - started) }, 'live fleet: snapshot build failed');
        throw err;
      },
    );
    const entry = run.finally(() => {
      if (this.inflight === entry) this.inflight = null;
    });
    this.inflight = entry;
    return entry;
  }

  private async build(now: Date): Promise<Omit<Built, 'completedAt'>> {
    const started = performance.now();
    const phases: LiveFleetPhases = {};
    const units: Record<string, number> = {};
    const mark = (phase: string, ms: number, count?: number): void => {
      phases[phase] = Math.round(ms * 10) / 10;
      if (count !== undefined) units[phase] = count;
    };
    const timed = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      try {
        return await run();
      } finally {
        mark(phase, performance.now() - t0);
      }
    };

    const until = new Date(now.getTime() + FUTURE_TOLERANCE_MS);
    const vehicles = await timed('vehicles', () => this.repo.findVehicles());
    const vehicleIds = vehicles.map((v) => v.id);
    const assigned = vehicles.flatMap((v) => (v.driver ? [v.driver] : []));
    // BUG-001 — the +2 h adverse extension only on a day it was invoked (§395.1(b)(1)).
    const drivers = withEffectiveAdverse(assigned, await timed('adverse', () => this.repo.findAdverseInvokedToday(assigned, now)));
    const driverIds = drivers.map((d) => d.id);

    const [telemetry, located, special, hosStates] = await Promise.all([
      timed('telemetry', () => this.repo.latestTelemetry(vehicleIds, until, mark)),
      timed('located', () => this.repo.latestLocatedEvents(vehicleIds, until, mark)),
      timed('special', () => this.repo.activeSpecialDriving(driverIds, new Date(now.getTime() - SPECIAL_LOOKBACK_MS), until)),
      // BE-003 — a driver with an invalid stored timezone is skipped on its own (no clocks for that
      // unit) instead of the engine throwing and every unit losing its clocks.
      timed('hos', () =>
        this.hos.computeCurrentStates(drivers.filter((d) => this.hosComputable(d)), now).catch((err: unknown) => {
          // The map is still useful without HOS clocks; never fail the whole fleet on the engine.
          this.logger.error({ err }, 'live fleet: HOS state computation failed — clocks omitted');
          return new Map<string, HosState>();
        }),
      ),
    ]);

    const mapStarted = performance.now();
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
    mark('map', performance.now() - mapStarted);
    mark('total', performance.now() - started);

    const log = { phases, units, vehicles: vehicles.length, drivers: drivers.length };
    if (phases.total >= LIVE_FLEET_SLOW_BUILD_MS) this.logger.warn(log, 'live fleet: slow snapshot build');
    else this.logger.log(log, 'live fleet: snapshot built');

    // `generatedAt` = the instant every clock and staleness flag in the snapshot is computed as of.
    return { value: { items, generatedAt: now.toISOString() }, phases, units };
  }

  private hosComputable(driver: { id: string; homeTerminalTimezone: string }): boolean {
    if (isValidIanaTimezone(driver.homeTerminalTimezone)) return true;
    this.logger.warn({ driverId: driver.id, timezone: driver.homeTerminalTimezone }, 'live fleet: invalid home-terminal timezone — HOS clocks omitted');
    return false;
  }
}

/**
 * LV-02 — the `Server-Timing` header for one read: the cache state, the served snapshot's age, and
 * the phase durations of the build that produced it (`app;dur=` is that build's total).
 */
export function serverTiming(read: LiveFleetRead): string {
  const metric = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '-');
  const parts = [`cache;desc="${read.cache}"`, `age;dur=${Math.round(read.ageMs)}`];
  for (const [phase, ms] of Object.entries(read.phases)) {
    const units = read.units[phase];
    parts.push(`${phase === 'total' ? 'app' : metric(phase)};dur=${ms}${units === undefined ? '' : `;desc="${units} units"`}`);
  }
  return parts.join(', ');
}
