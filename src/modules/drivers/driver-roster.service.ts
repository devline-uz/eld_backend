import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { parseSort } from '../../common/dto/list-query.dto';
import { QUEUES } from '../../core/queue/queue.constants';
import { resolveLimits } from '../hos/engine/limits';
import type { DutyStatus, HosState } from '../hos/hos.types';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import { ActiveViolationsService } from '../violations/active-violations.service';
import type { ContextUser } from '../../core/context/request-context';
import { dayKey } from '../hos/engine/timezone';
import { DriverRosterQueryDto, InvokeAdverseDrivingDto } from './dto/drivers.dto';
import { DriversRepository, DriverWithUnit } from './drivers.repository';
import { HOS_STATUS_STALE_ALERT, staleAlertJobId, staleStatusCapAt } from './lib/stale-status';
import { withEffectiveAdverse } from './lib/adverse-driving';

/** BUG-002 — the stale verdict for one driver's current status (clocks frozen at `staleSince`). */
interface StaleInfo {
  isStale: boolean;
  /** When the current status passed `MAX_PLAUSIBLE_STATUS_SEC` — the instant the clocks are as of. */
  staleSince: string | null;
}

const NOT_STALE: StaleInfo = { isStale: false, staleSince: null };

/** In-process first-level dedup of the stale alert (the BullMQ `jobId` is the cross-instance one). */
const STALE_ALERT_MEMO_MAX = 5000;
/** The deduplicating job is kept a week, so a still-stuck ELD re-alerts at most weekly. */
const STALE_ALERT_RETAIN_SEC = 7 * 24 * 3600;

/** `findById` returns a bare `Driver`; the roster rows also carry the unit. */
type StaleCheckDriver = Parameters<HosRecalcService['computeCurrentStates']>[0][number] &
  Pick<DriverWithUnit, 'id' | 'firstName' | 'lastName'> & { assignedVehicle?: DriverWithUnit['assignedVehicle'] };

/** The web's duty-status vocabulary (web `DriverRosterEntry.dutyStatus`). */
export type WebDutyStatus = 'DRIVING' | 'ON_DUTY' | 'SLEEPER' | 'OFF_DUTY';

/** Engine status is already the EFFECTIVE one: PC is OFF, YM is ON (§8.2 rules 10/11). */
const WEB_STATUS: Record<DutyStatus, WebDutyStatus> = { D: 'DRIVING', ON: 'ON_DUTY', SB: 'SLEEPER', OFF: 'OFF_DUTY' };

export function toWebDutyStatus(status: DutyStatus): WebDutyStatus {
  return WEB_STATUS[status];
}

export interface DriverRosterEntry {
  driver: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    homeTerminalName: string;
    appVersion: string | null;
    email: string | null;
    eldExempt: boolean;
    allowPersonalConveyance: boolean;
    allowYardMove: boolean;
    shortHaulException: boolean;
    splitSleeperEnabled: boolean;
  };
  dutyStatus: WebDutyStatus;
  unit: { id: string; unitNumber: string } | null;
  hos: { driveRemainingSec: number; shiftRemainingSec: number; cycleRemainingSec: number };
  /** BUG-001 — this driver's ruleset limits today (+2 h drive/shift only when adverse driving is invoked). */
  limits: { driveLimitSec: number; shiftLimitSec: number; cycleLimitSec: number };
  openViolations: number;
  /** §20 B-31 — real verification state from `Driver.emailVerifiedAt`; null when there's no
   * email on file at all (nothing to verify), true/false once there is. */
  emailVerified: boolean | null;
  /** BUG-002 — the current status ran past `MAX_PLAUSIBLE_STATUS_SEC` ("ELD connection lost"):
   * `hos` is frozen at `staleSince` instead of counting on to 0. */
  isStale: boolean;
  staleSince: string | null;
}

export interface DriverRosterPage {
  items: DriverRosterEntry[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** `GET /drivers/:id/hos` — web `DriverHosResponse`, plus the current duty status. */
export interface DriverHosClocks {
  driveRemainingSec: number;
  shiftRemainingSec: number;
  cycleRemainingSec: number;
  /** Driving seconds left before the 30-minute break is due (§395.3(a)(3)(ii)). */
  breakInSec: number;
  /** Start of the running 14-hour window; null when no shift is open. */
  onDutySince: string | null;
  cycleLimitSec: number;
  shiftLimitSec: number;
  driveLimitSec: number;
  breakLimitSec: number;
  dutyStatus: WebDutyStatus;
  statusSince: string;
  computedAt: string;
  /** BUG-002 — true when the current status is implausibly long (ELD connection lost); every
   * clock above is then as of `staleSince`, not `computedAt`. */
  isStale: boolean;
  staleSince: string | null;
}

const SORTABLE_FIELDS = ['username', 'firstName', 'lastName', 'cdlNumber', 'status', 'registeredAt', 'homeTerminalName'] as const;

/**
 * Web gaps B-1 / B-2 — the fleet-side READ of the HOS engine. Every clock here comes from
 * `computeHos` via `HosRecalcService` (the same input the recalc job and the drift sweep
 * build), never from `DailyLog` totals: shifts and breaks straddle midnight. Nothing is written.
 */
@Injectable()
export class DriverRosterService {
  private readonly logger = new Logger(DriverRosterService.name);
  /** BUG-002 — stale alerts already enqueued by this instance (keyed by the BullMQ job id). */
  private readonly staleAlerted = new Set<string>();

  constructor(
    private readonly drivers: DriversRepository,
    private readonly hos: HosRecalcService,
    @Optional() @InjectQueue(QUEUES.ALERT) private readonly alertQueue?: Queue,
    /** BUG-003 — the one web definition of an active violation (dashboard, roster, HOS log). */
    @Optional() private readonly activeViolations?: ActiveViolationsService,
  ) {}

  async roster(query: DriverRosterQueryDto, now: Date = new Date()): Promise<DriverRosterPage> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { lastName: 'asc' });
    // BUG-003 — rows in step with the live engine BEFORE `hasOpenViolation` filters on them.
    await this.activeViolations?.refresh(now);
    const { items: rows, total } = await this.drivers.listRoster(
      { status: query.status, q: query.q, terminal: query.terminal, hasOpenViolation: query.hasOpenViolation, exempt: query.exempt },
      query.page,
      query.limit,
      orderBy,
    );
    // BUG-001 — the +2 h adverse extension only on a day it was invoked (§395.1(b)(1)).
    const items = withEffectiveAdverse(rows, await this.drivers.findAdverseInvokedToday(rows, now));
    const ids = items.map((d) => d.id);
    const [states, openCounts] = await Promise.all([
      this.hos.computeCurrentStates(items, now),
      this.activeViolations ? this.activeViolations.openCountsByDriver(ids, now) : this.drivers.countOpenViolations(ids),
    ]);
    const stale = await this.capStaleStatuses(items, states, now);

    return {
      items: items.map((driver) =>
        this.toEntry(driver, states.get(driver.id), openCounts.get(driver.id) ?? 0, stale.get(driver.id) ?? NOT_STALE),
      ),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  async clocks(driverId: string, now: Date = new Date()): Promise<DriverHosClocks> {
    const row = await this.drivers.findById({ id: driverId });
    if (!row) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    // BUG-001 — `adverseDrivingEnabled` is the permission; the limits grow only on an invoked day.
    const [driver] = withEffectiveAdverse([row], await this.drivers.findAdverseInvokedToday([row], now));
    const states = await this.hos.computeCurrentStates([driver], now);
    // B-055: the batch omits a driver whose history exceeds the per-driver cap — never guess.
    if (!states.get(driver.id)) throw new AppException(ERROR_CODES.SERVICE_UNAVAILABLE, 'HOS clocks are unavailable for this driver.', 503);
    const stale = (await this.capStaleStatuses([driver], states, now)).get(driver.id) ?? NOT_STALE;
    const state = states.get(driver.id) as HosState;
    const limits = resolveLimits(driver.hosRuleset, {
      driverId: driver.id,
      adverseDrivingEnabled: driver.adverseDrivingEnabled,
      shortHaulException: driver.shortHaulException,
    });
    return {
      driveRemainingSec: state.driveRemainingSec,
      shiftRemainingSec: state.shiftRemainingSec,
      cycleRemainingSec: state.cycleRemainingSec,
      breakInSec: state.breakRemainingSec,
      onDutySince: state.shiftStartedAt ? state.shiftStartedAt.toISOString() : null,
      cycleLimitSec: limits.cycleLimitSec,
      shiftLimitSec: limits.shiftLimitSec,
      driveLimitSec: limits.driveLimitSec,
      breakLimitSec: limits.breakAfterSec,
      dutyStatus: toWebDutyStatus(state.currentStatus),
      statusSince: state.statusSince.toISOString(),
      computedAt: now.toISOString(),
      isStale: stale.isStale,
      staleSince: stale.staleSince,
    };
  }

  /**
   * BUG-001 — 49 CFR §395.1(b)(1): a dispatcher invokes adverse driving conditions for one RODS
   * day of a PERMITTED driver, with the required annotation. Only that day gets the +2 h drive /
   * shift extension. Re-invoking the same day replaces the annotation (one row per day).
   */
  async invokeAdverseDriving(driverId: string, dto: InvokeAdverseDrivingDto, actor: ContextUser | undefined, now: Date = new Date()) {
    const driver = await this.drivers.findById({ id: driverId });
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    if (!driver.adverseDrivingEnabled) {
      throw AppException.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Adverse driving is not enabled for this driver.', {
        adverseDrivingEnabled: 'Enable the adverse driving exception on the driver first.',
      });
    }
    const today = dayKey(driver.homeTerminalTimezone, now);
    const logDate = dto.date ?? today;
    if (logDate > today) {
      throw AppException.unprocessable(ERROR_CODES.VALIDATION_FAILED, 'Adverse driving cannot be invoked for a future day.', { date: 'Pick today or an earlier day.' });
    }
    const row = await this.drivers.upsertAdverseInvocation({
      driverId: driver.id,
      logDate: new Date(`${logDate}T00:00:00.000Z`),
      annotation: dto.annotation,
      invokedById: actor?.id ?? null,
      invokedByType: actor?.type === 'driver' ? 'driver' : 'user',
    });
    return { id: row.id, driverId: row.driverId, date: logDate, annotation: row.annotation, invokedById: row.invokedById, invokedByType: row.invokedByType, createdAt: row.createdAt.toISOString() };
  }

  /**
   * BUG-002 — a status open longer than `MAX_PLAUSIBLE_STATUS_SEC` is an ELD that stopped
   * reporting, not a driver who drove for four days. For each such driver the engine is re-run
   * AS OF the cap instant (so nothing accrues past it) and the entry in `states` is replaced;
   * one deduplicated `alert.eld_status_stale` is enqueued per stuck status. The shared engine
   * is untouched — this is a web-read-only layer.
   */
  private async capStaleStatuses(drivers: StaleCheckDriver[], states: Map<string, HosState>, now: Date): Promise<Map<string, StaleInfo>> {
    const out = new Map<string, StaleInfo>();
    for (const driver of drivers) {
      const state = states.get(driver.id);
      if (!state) continue;
      const capAt = staleStatusCapAt(state.currentStatus, state.statusSince, now);
      if (!capAt) continue;
      const capped = (await this.hos.computeCurrentStates([driver], capAt)).get(driver.id);
      // Same status still open at the cap ⇒ use the frozen clocks; anything else ⇒ keep the live read.
      if (capped && capped.currentStatus === state.currentStatus && capped.statusSince.getTime() === state.statusSince.getTime()) {
        states.set(driver.id, capped);
      }
      out.set(driver.id, { isStale: true, staleSince: capAt.toISOString() });
      await this.raiseStaleAlert(driver, state, capAt);
    }
    return out;
  }

  /** Dedup: in-process memo first, then the BullMQ `jobId` — a retained job with the same id is a no-op. */
  private async raiseStaleAlert(driver: StaleCheckDriver, state: HosState, capAt: Date): Promise<void> {
    if (!this.alertQueue) return;
    const jobId = staleAlertJobId(driver.id, state.statusSince);
    if (this.staleAlerted.has(jobId)) return;
    if (this.staleAlerted.size >= STALE_ALERT_MEMO_MAX) this.staleAlerted.clear();
    this.staleAlerted.add(jobId);
    const status = toWebDutyStatus(state.currentStatus);
    try {
      await this.alertQueue.add(
        HOS_STATUS_STALE_ALERT,
        {
          driverId: driver.id,
          vehicleId: driver.assignedVehicle?.id ?? null,
          dutyStatus: status,
          statusSince: state.statusSince.toISOString(),
          staleSince: capAt.toISOString(),
          title: 'ELD connection lost',
          message: `ELD connection lost: ${driver.firstName} ${driver.lastName} has been ${status} since ${state.statusSince.toISOString()} with no status change.`,
        },
        { jobId, removeOnComplete: { age: STALE_ALERT_RETAIN_SEC }, removeOnFail: { age: STALE_ALERT_RETAIN_SEC } },
      );
    } catch (err) {
      // A Redis blip must not fail the HOS read; let the next request retry the enqueue.
      this.staleAlerted.delete(jobId);
      this.logger.error({ err, driverId: driver.id }, `Failed to enqueue ${HOS_STATUS_STALE_ALERT}`);
    }
  }

  private toEntry(driver: DriverWithUnit, state: HosState | undefined, openViolations: number, stale: StaleInfo): DriverRosterEntry {
    const limits = resolveLimits(driver.hosRuleset, { driverId: driver.id, adverseDrivingEnabled: driver.adverseDrivingEnabled });
    return {
      driver: {
        id: driver.id,
        username: driver.username,
        firstName: driver.firstName,
        lastName: driver.lastName,
        homeTerminalName: driver.homeTerminalName,
        appVersion: driver.appVersion,
        email: driver.email,
        eldExempt: driver.eldExempt,
        allowPersonalConveyance: driver.allowPersonalConveyance,
        allowYardMove: driver.allowYardMove,
        shortHaulException: driver.shortHaulException,
        splitSleeperEnabled: driver.splitSleeperEnabled,
      },
      dutyStatus: state ? toWebDutyStatus(state.currentStatus) : 'OFF_DUTY',
      unit: driver.assignedVehicle ? { id: driver.assignedVehicle.id, unitNumber: driver.assignedVehicle.unitNumber } : null,
      hos: state
        ? { driveRemainingSec: state.driveRemainingSec, shiftRemainingSec: state.shiftRemainingSec, cycleRemainingSec: state.cycleRemainingSec }
        : { driveRemainingSec: limits.driveLimitSec, shiftRemainingSec: limits.shiftLimitSec, cycleRemainingSec: limits.cycleLimitSec },
      limits: { driveLimitSec: limits.driveLimitSec, shiftLimitSec: limits.shiftLimitSec, cycleLimitSec: limits.cycleLimitSec },
      openViolations,
      emailVerified: driver.email ? driver.emailVerifiedAt != null : null,
      isStale: stale.isStale,
      staleSince: stale.staleSince,
    };
  }
}
