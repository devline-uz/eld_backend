import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { DriverHosSnapshot } from '@prisma/client';
import { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { EventBusService } from '../../core/events/event-bus.service';
import { SentryService } from '../../core/observability/sentry.service';
import { QUEUES } from '../../core/queue/queue.constants';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import {
  compareHosState,
  toMobileShape,
  HOS_DRIFT_THRESHOLD_SEC,
  type DriftComparison,
  type MobileHosState,
  type ServerHosState,
} from './hos-drift';
import type { HosStateDto } from './dto/hos-state.dto';
import { HosStateRepository } from './hos-state.repository';

/** §8.6 — the alert name the panel and Sentry key off. */
export const HOS_ENGINE_DRIFT_ALERT = 'alert.hos_engine_drift';

/**
 * MR-1 — `POST /mobile/hos-state` only compares a snapshot computed within the last hour. An
 * older one (an offline-queue replay) is stored but answered with `reason: "STALE"`: events and
 * accepted edits that arrived since make the old numbers legitimately different.
 */
export const HOS_SNAPSHOT_STALE_SEC = 3600;

/**
 * MR-1 / D-NNN — the nightly sweep runs once a day, so its staleness bound must cover every
 * snapshot posted since the previous run (24 h) plus slack for a late or retried run.
 */
export const HOS_SWEEP_STALE_SEC = 36 * 3600;

/**
 * Numeric semver comparison of two `HOS_ENGINE_VERSION` strings: < 0 when `a` is older than `b`.
 * A part that is not a number compares as 0, so a malformed app version counts as older.
 */
export function compareEngineVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Why a stored snapshot was not compared. Optional and additive on the response. */
export type HosCompareSkipReason = 'STALE' | 'VERSION_MISMATCH' | 'DRIVER_NOT_FOUND';

export interface HosStateSubmitResult {
  /** The SERVER's engine version — the app shows the "update the app" banner when it differs. */
  hosEngineVersion: string;
  accepted: true;
  /** True when the app's engine version is not the server's: stored, but NOT compared (§8.6). */
  versionMismatch: boolean;
  /**
   * True when the app's engine is OLDER than the server's — the app shows "update the app". False on a
   * match and when the app is NEWER (the server is the one behind; nothing for the driver to do).
   */
  updateRequired: boolean;
  compared: boolean;
  /** MR-1 — set only when `compared` is false: `STALE` or `VERSION_MISMATCH`. */
  reason?: HosCompareSkipReason;
  /** MR-1 — with `reason: "STALE"`: how many seconds old the snapshot's `computedAt` is. */
  staleSec?: number;
  drift: boolean;
  maxDriftSec: number | null;
  fields: DriftComparison['fields'];
  statusMismatch: boolean;
  /** The server's own numbers, so the app can show the authoritative state immediately. */
  serverState: ServerHosState | null;
  driftThresholdSec: number;
  message?: string;
}

export interface CompareResult {
  driverId: string;
  compared: boolean;
  skippedVersion: boolean;
  /** MR-1 — not compared because `computedAt` is older than the staleness bound. */
  skippedStale?: boolean;
  /** MR-1 — age of the snapshot (`now - computedAt`, never negative), in seconds. */
  staleSec?: number;
  drift: boolean;
  maxDriftSec: number | null;
  comparison: DriftComparison | null;
  /** The server's own counters, already flattened — computed once, reused by the response. */
  serverState: ServerHosState | null;
}

@Injectable()
export class HosStateService {
  private readonly logger = new Logger(HosStateService.name);

  constructor(
    private readonly repo: HosStateRepository,
    private readonly recalc: HosRecalcService,
    private readonly events: EventBusService,
    private readonly sentry: SentryService,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
  ) {}

  /**
   * §8.6 point 5 — stores the app's state and compares it with the server's straight away, so a
   * drifting app is caught within five minutes instead of at the next nightly sweep.
   *
   * A version mismatch is NOT an error: the payload is still stored (it is evidence about which
   * engine the truck is running), the comparison is skipped, and the response tells the app to
   * update. Rejecting it outright would lose the one signal that says a fleet is on an old build.
   */
  async submit(driverId: string, dto: HosStateDto, now: Date = new Date()): Promise<HosStateSubmitResult> {
    const snapshot = await this.repo.upsertSnapshot({
      driverId,
      computedAt: dto.computedAt,
      hosEngineVersion: dto.hosEngineVersion,
      appPlatform: dto.appPlatform ?? null,
      state: dto.state,
    });

    const result = await this.compareSnapshot(snapshot, now, HOS_SNAPSHOT_STALE_SEC);
    const base = {
      hosEngineVersion: HOS_ENGINE_VERSION,
      accepted: true as const,
      driftThresholdSec: HOS_DRIFT_THRESHOLD_SEC,
    };

    if (result.skippedVersion) {
      // An outdated app is a known engine difference, never drift: no comparison, no alert (§8.6).
      const updateRequired = compareEngineVersions(dto.hosEngineVersion, HOS_ENGINE_VERSION) < 0;
      return {
        ...base,
        versionMismatch: true,
        updateRequired,
        compared: false,
        reason: 'VERSION_MISMATCH',
        drift: false,
        maxDriftSec: null,
        fields: [],
        statusMismatch: false,
        serverState: null,
        message: updateRequired
          ? `Stored, but not compared: this app computes HOS with engine ${dto.hosEngineVersion} and the server runs ${HOS_ENGINE_VERSION}. Update the app.`
          : `Stored, but not compared: this app computes HOS with engine ${dto.hosEngineVersion}, newer than the server's ${HOS_ENGINE_VERSION}. No action needed in the app.`,
      };
    }

    if (result.skippedStale) {
      return {
        ...base,
        versionMismatch: false,
        updateRequired: false,
        compared: false,
        reason: 'STALE',
        staleSec: result.staleSec,
        drift: false,
        maxDriftSec: null,
        fields: [],
        statusMismatch: false,
        serverState: null,
        message: `Stored, but not compared: computedAt is ${result.staleSec} s old (limit ${HOS_SNAPSHOT_STALE_SEC} s).`,
      };
    }

    if (!result.compared) {
      // The driver row vanished between the guard and here (deleted mid-request).
      throw AppException.notFound('Driver not found.', { driverId });
    }

    const comparison = result.comparison as DriftComparison;
    return {
      ...base,
      versionMismatch: false,
      updateRequired: false,
      compared: true,
      drift: comparison.drift,
      maxDriftSec: comparison.maxDriftSec,
      fields: comparison.fields,
      statusMismatch: comparison.statusMismatch,
      serverState: result.serverState,
    };
  }

  /**
   * The shared comparison used by both `POST /mobile/hos-state` and the nightly sweep.
   *
   * §8.6: when the snapshot's `hosEngineVersion` differs from the server's, the comparison is
   * SKIPPED entirely — an old app is not drift, and comparing two different rule versions would
   * alert on every driver who has not updated.
   *
   * MR-1 — the server state is computed AT `snapshot.computedAt` (the instant the app's numbers
   * describe), never at `now`: comparing a 30-minute-old app state with the server's current
   * state is 30 minutes of false drift. `now` is used only for `lastComparedAt` / `detectedAt`
   * and the staleness check. A `computedAt` in the future (device clock ahead) is clamped to
   * `now` — the server never projects HOS state forward. A snapshot older than `maxAgeSec` is
   * not compared at all (`skippedStale`), so it can never raise a drift alert.
   */
  async compareSnapshot(
    snapshot: DriverHosSnapshot,
    now: Date = new Date(),
    maxAgeSec: number = HOS_SWEEP_STALE_SEC,
  ): Promise<CompareResult> {
    if (snapshot.hosEngineVersion !== HOS_ENGINE_VERSION) {
      this.logger.debug(
        { driverId: snapshot.driverId, appVersion: snapshot.hosEngineVersion, serverVersion: HOS_ENGINE_VERSION },
        'HOS drift comparison skipped — engine version mismatch',
      );
      return { driverId: snapshot.driverId, compared: false, skippedVersion: true, drift: false, maxDriftSec: null, comparison: null, serverState: null };
    }

    const staleSec = Math.max(0, Math.floor((now.getTime() - snapshot.computedAt.getTime()) / 1000));
    if (staleSec > maxAgeSec) {
      this.logger.debug(
        { driverId: snapshot.driverId, staleSec, maxAgeSec },
        'HOS drift comparison skipped — snapshot is stale',
      );
      return { driverId: snapshot.driverId, compared: false, skippedVersion: false, skippedStale: true, staleSec, drift: false, maxDriftSec: null, comparison: null, serverState: null };
    }

    const comparedAt = snapshot.computedAt.getTime() > now.getTime() ? now : snapshot.computedAt;
    const server = await this.recalc.computeCurrentState(snapshot.driverId, comparedAt);
    if (!server) {
      return { driverId: snapshot.driverId, compared: false, skippedVersion: false, drift: false, maxDriftSec: null, comparison: null, serverState: null };
    }

    const app = snapshot.state as unknown as MobileHosState;
    const comparison = compareHosState(server.state, app);

    await this.repo.recordComparison(snapshot.driverId, {
      lastComparedAt: now,
      maxDriftSec: comparison.maxDriftSec,
      driftAlerted: comparison.drift,
    });

    if (comparison.drift) {
      await this.raiseDriftAlert(snapshot, comparison, now);
    }

    return {
      driverId: snapshot.driverId,
      compared: true,
      skippedVersion: false,
      staleSec,
      drift: comparison.drift,
      maxDriftSec: comparison.maxDriftSec,
      comparison,
      serverState: toMobileShape(server.state),
    };
  }

  /** §8.6 — `alert.hos_engine_drift` + Sentry, wired like every other alert (§7.6 raiseAlert). */
  private async raiseDriftAlert(
    snapshot: DriverHosSnapshot,
    comparison: DriftComparison,
    now: Date,
  ): Promise<void> {
    const payload = {
      driverId: snapshot.driverId,
      maxDriftSec: comparison.maxDriftSec,
      thresholdSec: HOS_DRIFT_THRESHOLD_SEC,
      statusMismatch: comparison.statusMismatch,
      serverStatus: comparison.serverStatus,
      appStatus: comparison.appStatus,
      fields: comparison.fields,
      hosEngineVersion: HOS_ENGINE_VERSION,
      appPlatform: snapshot.appPlatform,
      appComputedAt: snapshot.computedAt.toISOString(),
      detectedAt: now.toISOString(),
    };

    await this.events.publish(HOS_ENGINE_DRIFT_ALERT, payload);
    try {
      await this.alertQueue.add(HOS_ENGINE_DRIFT_ALERT, payload);
    } catch (err) {
      // The snapshot comparison is already persisted; a Redis blip must not lose the Sentry event.
      this.logger.error({ err, driverId: snapshot.driverId }, 'Failed to enqueue alert.hos_engine_drift');
    }

    this.sentry.capture({
      message: 'HOS engine drift',
      level: 'error',
      fingerprint: ['hos_engine_drift', HOS_ENGINE_VERSION],
      tags: {
        driverId: snapshot.driverId,
        hosEngineVersion: HOS_ENGINE_VERSION,
        appPlatform: snapshot.appPlatform ?? 'UNKNOWN',
        worstField: comparison.fields[0]?.field ?? (comparison.statusMismatch ? 'currentStatus' : 'none'),
      },
      extra: payload,
    });
  }

}
