import { Injectable, Logger } from '@nestjs/common';
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import { HosStateRepository } from './hos-state.repository';
import { HosStateService } from './hos-state.service';

/** One page of `DriverHosSnapshot` rows per round trip — the sweep is nightly, not interactive. */
export const DRIFT_SWEEP_PAGE_SIZE = 200;

export interface DriftSweepResult {
  /** Snapshots looked at. */
  scanned: number;
  /** Snapshots actually compared (version matched and the driver still exists). */
  compared: number;
  /** §8.6 — skipped because the app runs a different `HOS_ENGINE_VERSION`. */
  skippedVersion: number;
  /** Compared and found to drift beyond 60 s (or disagreeing about duty status). */
  drifted: number;
  /** Per-driver failures; one bad driver never aborts the sweep. */
  failed: number;
  hosEngineVersion: string;
  driverIds: string[];
}

/**
 * TZ §8.6 point 5 — the NIGHTLY comparison of the server's HOS state against the last state the
 * mobile engine reported. Every drift above 60 s raises `alert.hos_engine_drift` + Sentry
 * (`HosStateService.compareSnapshot`). Idempotent: rerunning it re-measures, it never writes
 * HOS data — the engine and the recalculation are untouched by this job.
 */
@Injectable()
export class HosDriftService {
  private readonly logger = new Logger(HosDriftService.name);

  constructor(
    private readonly repo: HosStateRepository,
    private readonly state: HosStateService,
  ) {}

  async runNightlySweep(now: Date = new Date()): Promise<DriftSweepResult> {
    const result: DriftSweepResult = {
      scanned: 0,
      compared: 0,
      skippedVersion: 0,
      drifted: 0,
      failed: 0,
      hosEngineVersion: HOS_ENGINE_VERSION,
      driverIds: [],
    };

    let cursor: string | null = null;
    for (;;) {
      const page: Awaited<ReturnType<HosStateRepository['listSnapshots']>> = await this.repo.listSnapshots(
        cursor,
        DRIFT_SWEEP_PAGE_SIZE,
      );
      if (!page.length) break;

      for (const snapshot of page) {
        result.scanned += 1;
        try {
          const comparison = await this.state.compareSnapshot(snapshot, now);
          if (comparison.skippedVersion) result.skippedVersion += 1;
          if (comparison.compared) result.compared += 1;
          if (comparison.drift) {
            result.drifted += 1;
            result.driverIds.push(snapshot.driverId);
          }
        } catch (err) {
          result.failed += 1;
          this.logger.error({ err, driverId: snapshot.driverId }, 'HOS drift comparison failed for one driver');
        }
      }

      cursor = page[page.length - 1].driverId;
      if (page.length < DRIFT_SWEEP_PAGE_SIZE) break;
    }

    this.logger.log(
      {
        scanned: result.scanned,
        compared: result.compared,
        skippedVersion: result.skippedVersion,
        drifted: result.drifted,
        failed: result.failed,
      },
      'HOS engine drift sweep done',
    );
    return result;
  }
}
