import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { parseSort } from '../../common/dto/list-query.dto';
import { resolveLimits } from '../hos/engine/limits';
import type { DutyStatus, HosState } from '../hos/hos.types';
import { HosRecalcService } from '../hos-recalc/hos-recalc.service';
import { DriverRosterQueryDto } from './dto/drivers.dto';
import { DriversRepository, DriverWithUnit } from './drivers.repository';

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
  openViolations: number;
  /** §20 B-31 — real verification state from `Driver.emailVerifiedAt`; null when there's no
   * email on file at all (nothing to verify), true/false once there is. */
  emailVerified: boolean | null;
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
}

const SORTABLE_FIELDS = ['username', 'firstName', 'lastName', 'cdlNumber', 'status', 'registeredAt', 'homeTerminalName'] as const;

/**
 * Web gaps B-1 / B-2 — the fleet-side READ of the HOS engine. Every clock here comes from
 * `computeHos` via `HosRecalcService` (the same input the recalc job and the drift sweep
 * build), never from `DailyLog` totals: shifts and breaks straddle midnight. Nothing is written.
 */
@Injectable()
export class DriverRosterService {
  constructor(
    private readonly drivers: DriversRepository,
    private readonly hos: HosRecalcService,
  ) {}

  async roster(query: DriverRosterQueryDto, now: Date = new Date()): Promise<DriverRosterPage> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { lastName: 'asc' });
    const { items, total } = await this.drivers.listRoster(
      { status: query.status, q: query.q, terminal: query.terminal, hasOpenViolation: query.hasOpenViolation, exempt: query.exempt },
      query.page,
      query.limit,
      orderBy,
    );
    const ids = items.map((d) => d.id);
    const [states, openCounts] = await Promise.all([
      this.hos.computeCurrentStates(items, now),
      this.drivers.countOpenViolations(ids),
    ]);

    return {
      items: items.map((driver) => this.toEntry(driver, states.get(driver.id), openCounts.get(driver.id) ?? 0)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  async clocks(driverId: string, now: Date = new Date()): Promise<DriverHosClocks> {
    const driver = await this.drivers.findById({ id: driverId });
    if (!driver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    const states = await this.hos.computeCurrentStates([driver], now);
    const state = states.get(driver.id);
    // B-055: the batch omits a driver whose history exceeds the per-driver cap — never guess.
    if (!state) throw new AppException(ERROR_CODES.SERVICE_UNAVAILABLE, 'HOS clocks are unavailable for this driver.', 503);
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
    };
  }

  private toEntry(driver: DriverWithUnit, state: HosState | undefined, openViolations: number): DriverRosterEntry {
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
      openViolations,
      emailVerified: driver.email ? driver.emailVerifiedAt != null : null,
    };
  }
}
