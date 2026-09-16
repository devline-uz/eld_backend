/**
 * Mock HOS generator — the PURE duty-timeline planner (no DB, no Prisma). `hos.ts` owns I/O.
 *
 * One `Planner` turns a driver profile into a contiguous list of duty segments covering
 * `start → end`. The plan is built against the REAL engine limits (`resolveLimits`), so a
 * shift that is not deliberately injected is compliant by construction — the unit tests
 * prove it by running `computeHos` over the output.
 *
 * Segments are the ORIGINAL (as-recorded) timeline. Driver self-edits (§9.3) are returned
 * separately as `EditPlan`s; `applyEdits()` gives the corrected timeline.
 */
import { resolveLimits, type RuleLimits } from '../../../src/modules/hos/engine/limits';
import { addDays, dayKey, dayStart } from '../../../src/modules/hos/engine/timezone';
import type { DutyStatus, HosRuleset, NormalizedEvent, SpecialDrivingCategory } from '../../../src/modules/hos/hos.types';
import type { MockRng } from '../context';

export const M = 60_000;
export const H = 60 * M;
export const DAY = 24 * H;

export type Profile = 'LONG_HAUL' | 'REGIONAL' | 'LOCAL';

export type SegTag =
  | 'PRE_TRIP'
  | 'YARD_MOVE'
  | 'DRIVE'
  | 'STOP'
  | 'BREAK'
  | 'DETENTION'
  | 'POST_TRIP'
  | 'FORGOT_ON'
  | 'PC'
  | 'REST'
  | 'SPLIT_SHORT'
  | 'SPLIT_LONG'
  | 'RESTART'
  | 'HOME'
  | 'TEAM_SB';

export interface Seg {
  status: DutyStatus;
  special: SpecialDrivingCategory;
  start: number;
  end: number;
  tag: SegTag;
  vehicleId: string | null;
  /** Inside a co-driver pairing window (engine keeps running across hand-offs). */
  team: boolean;
}

export type InjectKind = 'DRIVING_11' | 'SHIFT_14' | 'BREAK_30' | 'CYCLE' | 'FORGOT_OFF';

export interface Injection {
  kind: InjectKind;
  at: number;
}

export type EditKind = 'INSERT_OFF' | 'RELABEL_SB' | 'ADD_ON';

export interface EditPlan {
  kind: EditKind;
  /** The record instant the edit acts on. */
  start: number;
  /** ADD_ON only — where the RESTORE record lands. */
  end: number | null;
  restore: DutyStatus | null;
  editedAt: number;
  annotation: string;
}

export interface TeamWindow {
  start: number;
  end: number;
  role: 'A' | 'B';
  vehicleId: string;
}

export interface TailTarget {
  status: DutyStatus;
  nearLimit: boolean;
}

export interface InjectRates {
  driving11: number;
  shift14: number;
  break30: number;
  /** Chance of ignoring the cycle guard once when a restart is due. */
  cycleSkip: number;
  forgotOff: number;
  relabel: number;
  addOn: number;
  /** Share of long-haul shifts run as a split-sleeper episode (split-enabled drivers only). */
  split: number;
  pc: number;
  ym: number;
}

export const DEFAULT_RATES: InjectRates = {
  driving11: 0.02,
  shift14: 0.02,
  break30: 0.025,
  cycleSkip: 0.1,
  forgotOff: 0.008,
  relabel: 0.02,
  addOn: 0.015,
  split: 0.22,
  pc: 0.18,
  ym: 0.3,
};

export const COMPLIANT_RATES: InjectRates = { ...DEFAULT_RATES, driving11: 0, shift14: 0, break30: 0, cycleSkip: 0, forgotOff: 0 };

export interface PlanInput {
  profile: Profile;
  ruleset: HosRuleset;
  timezone: string;
  flags: { pc: boolean; ym: boolean; split: boolean; shortHaul: boolean; adverse: boolean };
  /** First instant of the plan — a local midnight. */
  start: number;
  /** Last instant: `now`, or the termination instant. */
  end: number;
  now: number;
  vehicleId: string | null;
  teams: TeamWindow[];
  /**
   * Instants when `vehicleId` is already taken by another driver's plan (sorted, non-overlapping).
   * A solo shift is never placed across one of them: a spare unit shared by several unassigned
   * drivers can only be driven by one of them at a time (B-060).
   */
  busy?: Interval[];
  tail: TailTarget | null;
  rates: InjectRates;
}

export interface Interval {
  start: number;
  end: number;
}

export interface Plan {
  segments: Seg[];
  injections: Injection[];
  edits: EditPlan[];
  restarts: number;
  splits: Array<{ longH: number; shortH: number; at: number }>;
}

interface Part {
  status: DutyStatus;
  special: SpecialDrivingCategory;
  dur: number;
  tag: SegTag;
}

interface ProfileParams {
  drive: [number, number];
  leg: [number, number];
  stop: [number, number];
  breakMax: number;
}

const PROFILE: Record<Profile, ProfileParams> = {
  LONG_HAUL: { drive: [8.5, 10.4], leg: [2, 4.5], stop: [10, 25], breakMax: 50 },
  REGIONAL: { drive: [6.5, 9.8], leg: [1.5, 3.5], stop: [10, 25], breakMax: 55 },
  LOCAL: { drive: [3.5, 7.5], leg: [0.4, 1.6], stop: [10, 28], breakMax: 60 },
};

// ---------------------------------------------------------------------------------------------
// Fast local-day helpers. US zones use whole-hour offsets, so a UTC hour bucket never straddles
// a local midnight and the key can be cached per bucket.
// ---------------------------------------------------------------------------------------------

const dayKeyCache = new Map<string, Map<number, string>>();
const dayStartCache = new Map<string, number>();

export function fastDayKey(timezone: string, ms: number): string {
  let cache = dayKeyCache.get(timezone);
  if (!cache) {
    cache = new Map();
    dayKeyCache.set(timezone, cache);
  }
  const bucket = Math.floor(ms / H);
  let key = cache.get(bucket);
  if (key === undefined) {
    key = dayKey(timezone, new Date(bucket * H));
    cache.set(bucket, key);
  }
  return key;
}

export function fastDayStart(timezone: string, key: string): number {
  const cacheKey = `${timezone}|${key}`;
  let value = dayStartCache.get(cacheKey);
  if (value === undefined) {
    value = dayStart(timezone, key).getTime();
    dayStartCache.set(cacheKey, value);
  }
  return value;
}

export function weekday(key: string): number {
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

export function effective(status: DutyStatus, special: SpecialDrivingCategory): DutyStatus {
  if (special === 'PC') return 'OFF';
  if (special === 'YM') return 'ON';
  return status;
}

const isRest = (status: DutyStatus): boolean => status === 'OFF' || status === 'SB';

/** Longest shift-plus-rest a single loop step can place (a split episode is ~28 h, plus 10.5 h rest). */
const RESERVE = 41 * H;

// ---------------------------------------------------------------------------------------------

export class Planner {
  private readonly segments: Seg[] = [];
  private readonly injections: Injection[] = [];
  private readonly edits: EditPlan[] = [];
  private readonly splits: Plan['splits'] = [];
  private restarts = 0;
  private cursor: number;
  private readonly dayOn = new Map<string, number>();
  private readonly limits: RuleLimits;
  private lastWorkEnd: number;
  private lastShiftStart: number;
  /** Start of the continuous OFF/SB run the cursor is in, or null while working. */
  private restRunStart: number | null = null;
  private forceLongNext = false;
  private forgotRest: number | null = null;
  private tripEnd = 0;
  private vacation: [number, number] | null = null;
  private tailStart = Infinity;
  private tailParts: Part[] = [];
  private tailRest: { status: DutyStatus; tag: SegTag } | null = null;

  constructor(
    private readonly rng: MockRng,
    private readonly input: PlanInput,
  ) {
    this.limits = resolveLimits(input.ruleset, {
      driverId: 'plan',
      adverseDrivingEnabled: input.flags.adverse,
      shortHaulException: input.flags.shortHaul,
      splitSleeperEnabled: input.flags.split,
    });
    this.cursor = input.start;
    this.lastWorkEnd = input.start - 12 * H;
    this.lastShiftStart = input.start - 24 * H;
  }

  plan(): Plan {
    const { start, end } = this.input;
    this.computeTail();
    const stopAt = Math.min(end, this.tailStart);

    if (this.rng.chance(0.6) && end - start > 40 * DAY) {
      const vStart = start + this.rng.float(14, (end - start) / DAY - 14) * DAY;
      this.vacation = [vStart, vStart + this.rng.int(5, 9) * DAY];
    }
    this.tripEnd = start + this.rng.float(2, 14) * DAY;

    for (let guard = 0; guard < 5000; guard += 1) {
      const next = this.nextShiftStart();
      const team = this.teamBefore(next + 48 * H);
      if (team) {
        if (next + RESERVE + 34 * H <= team.start && next + RESERVE <= stopAt) {
          // Still room for a solo shift before the pre-team restart.
        } else {
          if (team.start >= stopAt) break;
          this.restUntil(team.start, 'OFF', 'HOME');
          this.teamBlock(team);
          continue;
        }
      }
      if (next + RESERVE > stopAt) break;
      if (!this.workOnce(next)) continue;
    }

    if (this.tailStart !== Infinity && this.tailStart < end) {
      this.restUntil(this.tailStart, this.defaultRestStatus(), 'REST');
      this.placeParts(this.tailParts, Infinity);
      this.lastWorkEnd = this.cursor;
      if (this.tailRest) this.pushSeg(this.tailRest.status, 'NONE', this.input.now + H - this.cursor, this.tailRest.tag);
    } else {
      this.restUntil(end, 'OFF', 'HOME');
    }

    return {
      segments: this.clip(),
      injections: this.injections.filter((i) => i.at < end),
      edits: this.edits.filter((e) => e.editedAt <= this.input.now && e.start < end && e.editedAt <= end + 2 * DAY),
      restarts: this.restarts,
      splits: this.splits.filter((s) => s.at < end),
    };
  }

  // ---- scheduling ----------------------------------------------------------------------------

  /** Where the next shift starts, given the rest already in progress at `cursor`. */
  private nextShiftStart(): number {
    const r = this.rng;
    const { profile, timezone } = this.input;
    const minRest = this.cursor + 10.2 * H;

    if (this.forgotRest !== null) {
      const next = this.lastWorkEnd + this.forgotRest;
      this.forgotRest = null;
      return Math.max(next, this.cursor + 5 * M);
    }

    const inVacation = (t: number): boolean => this.vacation !== null && t >= this.vacation[0] && t < this.vacation[1];

    if (profile === 'LOCAL') {
      let key = fastDayKey(timezone, minRest);
      for (let i = 0; i < 30; i += 1) {
        const wd = weekday(key);
        const works = (wd >= 1 && wd <= 5) || (wd === 6 && r.chance(0.12));
        const at = fastDayStart(timezone, key) + r.float(4.75, 7.5) * H;
        if (works && at >= minRest && !inVacation(at) && !(wd >= 1 && wd <= 5 && r.chance(0.03))) return at;
        key = addDays(key, 1);
      }
      return minRest + DAY;
    }

    if (profile === 'REGIONAL') {
      const candidate = this.cursor + r.float(10.2, 11.8) * H;
      const key = fastDayKey(timezone, candidate);
      const wd = weekday(key);
      const localHour = (candidate - fastDayStart(timezone, key)) / H;
      const weekend = wd === 6 || wd === 0 || (wd === 5 && localHour > 12);
      if (!weekend && !inVacation(candidate)) return candidate;
      // Home for the weekend: back out Monday early morning (sometimes Sunday evening).
      let monday = key;
      for (let i = 0; i < 8 && weekday(monday) !== 1; i += 1) monday = addDays(monday, 1);
      if (weekday(key) === 1) monday = addDays(key, 7);
      let at = r.chance(0.12) ? fastDayStart(timezone, addDays(monday, -1)) + r.float(18, 22) * H : fastDayStart(timezone, monday) + r.float(3.5, 7) * H;
      while (inVacation(at)) at += 7 * DAY;
      return Math.max(at, minRest);
    }

    // LONG_HAUL
    if (this.cursor >= this.tripEnd || inVacation(this.cursor)) {
      let home = this.cursor + r.float(2, 4.5) * DAY;
      if (inVacation(home) && this.vacation) home = this.vacation[1] + r.float(2, 12) * H;
      this.tripEnd = home + r.float(10, 18) * DAY;
      return home;
    }
    return this.cursor + r.float(10.2, 12) * H;
  }

  /** Plans and places one shift at `at`. Returns false when a restart was taken instead. */
  private workOnce(at: number): boolean {
    const r = this.rng;
    const { profile, rates, flags } = this.input;
    const L = this.limits;
    const passenger = L.driveLimitSec < 11 * 3600 && !flags.adverse;

    let kind: 'NORMAL' | 'DRIVING_11' | 'SHIFT_14' | 'BREAK_30' | 'SPLIT' = 'NORMAL';
    let parts: Part[];
    if (this.forceLongNext) {
      this.forceLongNext = false;
      parts = this.normalShift({ target: (L.driveLimitSec * 1000) - r.int(40, 75) * M });
    } else {
      const x = r.next();
      if (x < rates.driving11) kind = 'DRIVING_11';
      else if (x < rates.driving11 + rates.shift14) kind = 'SHIFT_14';
      else if (x < rates.driving11 + rates.shift14 + rates.break30 && L.breakRequired) kind = 'BREAK_30';
      else if (profile === 'LONG_HAUL' && flags.split && !passenger && r.chance(rates.split)) kind = 'SPLIT';
      parts =
        kind === 'DRIVING_11' ? this.overDriveShift()
        : kind === 'SHIFT_14' ? this.shift14Shift()
        : kind === 'BREAK_30' ? this.break30Shift()
        : kind === 'SPLIT' ? this.splitEpisode()
        : this.normalShift();
    }

    // Shared unit guard (B-060): the whole shift must fit before the next reservation on the
    // truck; otherwise keep resting until that reservation is over and plan again from there.
    const span = parts.reduce((sum, p) => sum + p.dur, 0);
    if (this.vehicleFor(at) === this.input.vehicleId) {
      const clash = this.busyClash(at, at + span);
      if (clash) {
        const rest = this.lastRestStatusBefore(at);
        this.restUntil(clash.end + 15 * M, rest.status, rest.tag);
        return false;
      }
    }

    // Cycle guard (§395.3(b)) — conservative: the planned on-duty time is billed against a
    // window one day wider than the engine's, so a shift that crosses midnight still fits.
    const need = parts.reduce((sum, p) => sum + (effective(p.status, p.special) === 'ON' || effective(p.status, p.special) === 'D' ? p.dur : 0), 0);
    if (this.cycleRoom(at) < need + 60 * M) {
      if (profile !== 'LOCAL' && r.chance(rates.cycleSkip) && this.cycleRoom(at) > 0) {
        this.injections.push({ kind: 'CYCLE', at });
      } else {
        const restartEnd = Math.max(this.cursor, this.lastWorkEnd + r.float(34.5, 40) * H);
        this.restUntil(restartEnd, profile === 'LONG_HAUL' ? 'SB' : 'OFF', 'RESTART');
        return false;
      }
    }

    if (kind === 'DRIVING_11' || kind === 'SHIFT_14' || kind === 'BREAK_30') this.injections.push({ kind, at });
    if (kind === 'SPLIT') {
      const shortPart = parts.find((p) => p.tag === 'SPLIT_SHORT');
      const longPart = parts.find((p) => p.tag === 'SPLIT_LONG');
      if (shortPart && longPart) this.splits.push({ longH: longPart.dur / H, shortH: shortPart.dur / H, at });
    }

    const rest = this.lastRestStatusBefore(at);
    this.restUntil(at, rest.status, rest.tag);
    const shiftStart = this.cursor;
    this.placeParts(parts, this.input.end);
    this.lastShiftStart = shiftStart;
    this.lastWorkEnd = this.cursor;

    // After the shift: personal conveyance, or a forgotten status change.
    const regularRestFollows = profile !== 'LOCAL' && this.cycleRoom(this.cursor + 11 * H) > 26 * H;
    if (flags.pc && r.chance(rates.pc)) {
      this.pushSeg('OFF', 'PC', r.int(8, 35) * M, 'PC');
    } else if (regularRestFollows && kind === 'NORMAL' && r.chance(rates.forgotOff) && this.cursor + 3 * DAY < this.input.end) {
      const actualRest = r.float(10.6, 11.2) * H;
      const forgot = r.float(actualRest - 9.6 * H, 2.4 * H);
      const forgotStart = this.cursor;
      this.pushSeg('ON', 'NONE', forgot, 'FORGOT_ON');
      this.forgotRest = actualRest;
      this.forceLongNext = true;
      this.injections.push({ kind: 'FORGOT_OFF', at: forgotStart });
      this.edits.push({
        kind: 'INSERT_OFF',
        start: forgotStart,
        end: null,
        restore: null,
        editedAt: forgotStart + r.float(30, 72) * H,
        annotation: 'Forgot to go off duty after post-trip',
      });
    }
    return true;
  }

  private lastRestStatusBefore(at: number): { status: DutyStatus; tag: SegTag } {
    const gap = at - this.lastWorkEnd;
    if (gap >= 34 * H) return { status: this.input.profile === 'LONG_HAUL' && gap < 50 * H ? 'SB' : 'OFF', tag: gap < 50 * H && this.input.profile === 'LONG_HAUL' ? 'RESTART' : 'HOME' };
    if (this.input.profile === 'LOCAL') return { status: 'OFF', tag: 'HOME' };
    return { status: this.defaultRestStatus(), tag: 'REST' };
  }

  private defaultRestStatus(): DutyStatus {
    if (this.input.profile === 'LOCAL') return 'OFF';
    if (this.input.profile === 'LONG_HAUL') return this.rng.chance(0.85) ? 'SB' : 'OFF';
    return this.rng.chance(0.55) ? 'SB' : 'OFF';
  }

  private cycleRoom(at: number): number {
    const key = fastDayKey(this.input.timezone, at);
    let used = this.dayOn.get(addDays(key, 1)) ?? 0;
    for (let back = 0; back < this.limits.cycleDays; back += 1) used += this.dayOn.get(addDays(key, -back)) ?? 0;
    return this.limits.cycleLimitSec * 1000 - used;
  }

  private teamBefore(limit: number): TeamWindow | null {
    const upcoming = this.input.teams.filter((t) => t.end > this.cursor && t.start < limit).sort((a, b) => a.start - b.start);
    return upcoming[0] ?? null;
  }

  // ---- shift builders ------------------------------------------------------------------------

  private normalShift(o: { target?: number; overDrive?: boolean; shortStops?: boolean; noYm?: boolean } = {}): Part[] {
    const r = this.rng;
    const prof = PROFILE[this.input.profile];
    const L = this.limits;
    const parts: Part[] = [];
    let el = 0;
    let drive = 0;
    let since = 0;
    const add = (p: Part): void => {
      parts.push(p);
      el += p.dur;
      if (p.status === 'D' && p.special === 'NONE') {
        drive += p.dur;
        since += p.dur;
      }
    };
    const driveCap = o.overDrive ? Infinity : L.driveLimitSec * 1000 - 15 * M;
    const windowCap = L.shiftLimitSec * 1000 - 20 * M;
    const breakCap = 8 * H - 15 * M;
    const post = r.int(10, 18) * M;
    const legRange: [number, number] = o.overDrive ? [3.5, 4.5] : prof.leg;

    if (!o.noYm && this.input.flags.ym && r.chance(this.input.rates.ym)) {
      add({ status: 'ON', special: 'YM', dur: r.int(4, 12) * M, tag: 'YARD_MOVE' });
    }
    add({ status: 'ON', special: 'NONE', dur: r.int(o.shortStops ? 10 : 12, o.shortStops ? 15 : 25) * M, tag: 'PRE_TRIP' });
    const target = Math.min(o.target ?? r.float(prof.drive[0], prof.drive[1]) * H, driveCap);

    for (let guard = 0; guard < 40 && drive < target - M; guard += 1) {
      let leg = Math.min(r.float(legRange[0], legRange[1]) * H, target - drive, breakCap - since);
      if (leg < 10 * M && target - drive >= 10 * M) {
        const b = r.int(30, o.shortStops ? 34 : prof.breakMax) * M;
        if (el + b + post + 10 * M > windowCap) break;
        add({ status: r.chance(0.5) ? 'OFF' : 'ON', special: 'NONE', dur: b, tag: 'BREAK' });
        since = 0;
        continue;
      }
      if (el + leg + post > windowCap) leg = windowCap - post - el;
      leg = Math.floor(leg / M) * M;
      if (leg < 5 * M) break;
      add({ status: 'D', special: 'NONE', dur: leg, tag: 'DRIVE' });
      if (drive >= target - M) break;

      const wantBreak = since > breakCap - 2 * H || (!o.shortStops && r.chance(0.3));
      const dur = wantBreak ? r.int(30, o.shortStops ? 34 : prof.breakMax) * M : r.int(prof.stop[0], o.shortStops ? 14 : prof.stop[1]) * M;
      if (el + dur + post + 10 * M > windowCap) break;
      if (wantBreak) {
        add({ status: r.chance(0.55) ? 'OFF' : 'ON', special: 'NONE', dur, tag: 'BREAK' });
        since = 0;
      } else {
        add({ status: 'ON', special: 'NONE', dur, tag: 'STOP' });
      }
    }
    add({ status: 'ON', special: 'NONE', dur: post, tag: 'POST_TRIP' });
    return parts;
  }

  /** DRIVING_11 — drives past the driving limit, inside the window, with a proper break. */
  private overDriveShift(): Part[] {
    const target = this.limits.driveLimitSec * 1000 + this.rng.int(15, 45) * M;
    return this.normalShift({ target, overDrive: true, shortStops: true, noYm: true });
  }

  /** SHIFT_14 — a long detention pushes the last drive leg past the window; drive stays legal. */
  private shift14Shift(): Part[] {
    const r = this.rng;
    const L = this.limits;
    const pre = 15 * M;
    const d1 = r.int(195, 225) * M;
    const d2 = Math.min(L.driveLimitSec * 1000 - 15 * M - d1, 8 * H - 20 * M);
    const over = r.int(15, 60) * M;
    const detention = Math.max(35 * M, L.shiftLimitSec * 1000 + over - pre - d1 - d2);
    return [
      { status: 'ON', special: 'NONE', dur: pre, tag: 'PRE_TRIP' },
      { status: 'D', special: 'NONE', dur: d1, tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: detention, tag: 'DETENTION' },
      { status: 'D', special: 'NONE', dur: d2, tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: r.int(10, 15) * M, tag: 'POST_TRIP' },
    ];
  }

  /** BREAK_30 — 8 h+ of driving broken only by a short fuel stop. */
  private break30Shift(): Part[] {
    const r = this.rng;
    const d1 = r.int(210, 270) * M;
    const d2 = 8 * H + r.int(10, 50) * M - d1;
    const d3 = Math.min(r.int(30, 80) * M, this.limits.driveLimitSec * 1000 - 20 * M - d1 - d2);
    return [
      { status: 'ON', special: 'NONE', dur: r.int(12, 20) * M, tag: 'PRE_TRIP' },
      { status: 'D', special: 'NONE', dur: d1, tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: r.int(10, 20) * M, tag: 'STOP' },
      { status: 'D', special: 'NONE', dur: d2, tag: 'DRIVE' },
      { status: 'OFF', special: 'NONE', dur: r.int(30, 40) * M, tag: 'BREAK' },
      { status: 'D', special: 'NONE', dur: Math.max(10 * M, d3), tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: r.int(10, 15) * M, tag: 'POST_TRIP' },
    ];
  }

  /**
   * Split sleeper (§395.1(g)(1)): short part first, then the ≥ 7 h SB part. Work between the
   * parts is sized so the window still fits while the short part is not yet excluded.
   */
  private splitEpisode(): Part[] {
    const r = this.rng;
    const [longH, shortH] = r.pick([
      [7, 3],
      [8, 2],
      [7.5, 2.5],
    ] as const);
    const j = (): number => r.int(0, 15) * M;
    return [
      { status: 'ON', special: 'NONE', dur: 15 * M, tag: 'PRE_TRIP' },
      { status: 'D', special: 'NONE', dur: 3 * H - j(), tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: 30 * M, tag: 'BREAK' },
      { status: 'D', special: 'NONE', dur: 1.75 * H - j(), tag: 'DRIVE' },
      { status: r.chance(0.5) ? 'SB' : 'OFF', special: 'NONE', dur: shortH * H, tag: 'SPLIT_SHORT' },
      { status: 'ON', special: 'NONE', dur: 15 * M, tag: 'PRE_TRIP' },
      { status: 'D', special: 'NONE', dur: 3.5 * H - j(), tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: 15 * M, tag: 'STOP' },
      { status: 'SB', special: 'NONE', dur: longH * H, tag: 'SPLIT_LONG' },
      { status: 'ON', special: 'NONE', dur: 15 * M, tag: 'PRE_TRIP' },
      { status: 'D', special: 'NONE', dur: 5 * H - j(), tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: 30 * M, tag: 'BREAK' },
      { status: 'D', special: 'NONE', dur: 1.5 * H - j(), tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: 15 * M, tag: 'POST_TRIP' },
    ];
  }

  /**
   * Team driving: 10.5 h legs alternate between the two co-drivers while the other is in the
   * berth; a 34 h restart for both after ten legs. The timetable is ABSOLUTE — anchored at
   * `team.start`, not at this driver's cursor — so a co-driver whose plan begins later (hired after
   * the pairing started, back from vacation) joins the same legs instead of a shifted copy of them
   * that would have both drivers in D on one truck (B-060). Deterministic (no rng), so both roles
   * agree.
   */
  private teamBlock(team: TeamWindow): void {
    this.restUntil(team.start, 'OFF', 'HOME');
    const work: Part[] = [
      { status: 'ON', special: 'NONE', dur: 15 * M, tag: 'PRE_TRIP' },
      { status: 'D', special: 'NONE', dur: 4.75 * H, tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: 30 * M, tag: 'BREAK' },
      { status: 'D', special: 'NONE', dur: 4.5 * H, tag: 'DRIVE' },
      { status: 'ON', special: 'NONE', dur: 30 * M, tag: 'POST_TRIP' },
    ];
    const limit = Math.min(team.end, this.input.end);
    for (const slot of teamTimetable(team.start, limit)) {
      // A window ending at a millisecond instant (e.g. `now`) can leave a sub-second remainder that
      // `pushSeg` rounds away — stop instead of spinning on a slot that cannot advance the cursor.
      if (limit - this.cursor < 1000) break;
      if (slot.end <= this.cursor) continue;
      const before = this.cursor;
      if (slot.kind === 'RESTART') {
        this.pushSeg('OFF', 'NONE', slot.end - this.cursor, 'RESTART', true);
      } else if (slot.driver === team.role) {
        // Legs are placed inside their own slot: even a late-joining driver's D stays within the
        // slot the other driver spends in the berth.
        this.placeParts(work, slot.end, true);
        this.lastWorkEnd = this.cursor;
      } else {
        this.pushSeg('SB', 'NONE', slot.end - this.cursor, 'TEAM_SB', true);
      }
      if (this.cursor === before) break;
    }
    this.cursor = Math.max(this.cursor, limit);
  }

  /** The busy interval on the solo unit that [from, to) runs into, or null. */
  private busyClash(from: number, to: number): Interval | null {
    const busy = this.input.busy;
    if (!busy?.length) return null;
    for (const b of busy) {
      if (b.start >= to) break;
      if (b.end > from) return b;
    }
    return null;
  }

  // ---- tail: the driver's state right now ----------------------------------------------------

  private computeTail(): void {
    const { tail, now, end, start, teams } = this.input;
    if (!tail || end < now) return;
    const r = this.rng;
    const L = this.limits;
    const status = this.input.profile === 'LOCAL' && tail.status === 'SB' ? 'OFF' : tail.status;

    if (status === 'D' || status === 'ON') {
      const parts = tail.nearLimit
        ? this.normalShift({ target: L.driveLimitSec * 1000 - r.int(25, 55) * M, noYm: true })
        : this.normalShift();
      const offsets: Array<{ from: number; to: number }> = [];
      let t = 0;
      for (const p of parts) {
        if (p.status === status && p.special === 'NONE') offsets.push({ from: t, to: t + p.dur });
        t += p.dur;
      }
      if (offsets.length) {
        let point: number;
        if (tail.nearLimit && status === 'D') {
          const last = offsets[offsets.length - 1];
          point = Math.max(last.from + M, last.to - r.int(3, 20) * M);
        } else {
          const pick = r.pick(offsets);
          point = pick.from + r.float(0.15, 0.85) * (pick.to - pick.from);
        }
        this.tailStart = now - Math.round(point / 1000) * 1000;
        this.tailParts = parts;
        this.tailRest = null;
      }
    }
    if (this.tailStart === Infinity) {
      const parts = this.normalShift();
      const total = parts.reduce((s, p) => s + p.dur, 0);
      const restLen = tail.nearLimit ? r.float(12, 30) * H : r.float(0.3, 9.5) * H;
      this.tailStart = now - restLen - total;
      this.tailParts = parts;
      const restStatus: DutyStatus = status === 'SB' ? 'SB' : 'OFF';
      this.tailRest = { status: restStatus, tag: tail.nearLimit ? 'HOME' : 'REST' };
    }
    const blocked = teams.some((w) => w.end > this.tailStart - 40 * H) || this.busyClash(this.tailStart, now + H) !== null;
    if (this.tailStart < start + 3 * DAY || blocked) {
      this.tailStart = Infinity;
      this.tailParts = [];
      this.tailRest = null;
    }
  }

  // ---- low-level placement -------------------------------------------------------------------

  private placeParts(parts: Part[], limit: number, team = false): void {
    for (const p of parts) {
      if (this.cursor >= limit) return;
      this.pushSeg(p.status, p.special, Math.min(p.dur, limit - this.cursor), p.tag, team);
    }
  }

  private restUntil(until: number, status: DutyStatus, tag: SegTag): void {
    if (until <= this.cursor) return;
    const r = this.rng;
    const prev = this.segments[this.segments.length - 1];
    const restStart = this.cursor;
    const dur = until - restStart;
    this.pushSeg(status, 'NONE', dur, tag);

    // Driver self-edits that change nothing the engine counts against the driver.
    if (prev && prev.tag === 'POST_TRIP' && prev.end === restStart && tag !== 'RESTART') {
      const shiftLen = restStart - this.lastShiftStart;
      if (status === 'OFF' && tag === 'REST' && r.chance(this.input.rates.relabel)) {
        this.edits.push({
          kind: 'RELABEL_SB',
          start: restStart,
          end: null,
          restore: null,
          editedAt: until + r.float(0.3, 20) * H,
          annotation: 'Rested in sleeper berth, not off duty',
        });
      } else if (dur >= 11 * H && shiftLen <= 12.75 * H && r.chance(this.input.rates.addOn)) {
        const onEnd = restStart + r.int(15, 30) * M;
        this.edits.push({
          kind: 'ADD_ON',
          start: restStart,
          end: onEnd,
          restore: status,
          editedAt: restStart + r.float(12, 40) * H,
          annotation: 'Post-trip inspection not logged',
        });
      }
    }
  }

  private pushSeg(status: DutyStatus, special: SpecialDrivingCategory, dur: number, tag: SegTag, team = false): void {
    if (dur <= 0) return;
    const start = this.cursor;
    const end = start + Math.round(dur / 1000) * 1000;
    if (end <= start) return;
    this.segments.push({ status, special, start, end, tag, vehicleId: this.vehicleFor(start), team });
    const eff = effective(status, special);
    if (eff === 'ON' || eff === 'D') this.accrue(start, end);
    // §395.3(c) — only a CONTINUOUS 34 h OFF/SB run restarts the cycle (a 30-minute break
    // inside the first shift after home time must not wipe that shift's hours).
    if (isRest(eff)) {
      if (this.restRunStart === null) this.restRunStart = start;
      if (end - this.restRunStart >= 34 * H) {
        if (this.dayOn.size) this.restarts += 1;
        this.dayOn.clear();
      }
    } else {
      this.restRunStart = null;
    }
    this.cursor = end;
  }

  private accrue(start: number, end: number): void {
    const tz = this.input.timezone;
    let from = start;
    while (from < end) {
      const key = fastDayKey(tz, from);
      const next = fastDayStart(tz, addDays(key, 1));
      const to = Math.min(end, next);
      this.dayOn.set(key, (this.dayOn.get(key) ?? 0) + (to - from));
      from = to;
    }
  }

  private vehicleFor(t: number): string | null {
    const team = this.input.teams.find((w) => t >= w.start && t < w.end);
    return team ? team.vehicleId : this.input.vehicleId;
  }

  private clip(): Seg[] {
    const { start, end } = this.input;
    const out: Seg[] = [];
    for (const s of this.segments) {
      const from = Math.max(s.start, start);
      const to = Math.min(s.end, end);
      if (to <= from) continue;
      out.push({ ...s, start: from, end: to });
    }
    return out;
  }
}

export interface TeamSlot {
  kind: 'LEG' | 'RESTART';
  start: number;
  end: number;
  /** LEG only — the role that drives this leg; the other role is in the berth. */
  driver: 'A' | 'B' | null;
}

/**
 * The shared team timetable from `teamStart` up to `limit`: ten 10.5 h legs (A drives the even
 * ones, B the odd ones), then a 34 h restart for both, repeated. Both co-drivers derive their
 * slots from the same anchor, so their driving can never overlap on the truck.
 */
export function teamTimetable(teamStart: number, limit: number): TeamSlot[] {
  const out: TeamSlot[] = [];
  let t = teamStart;
  for (let leg = 0; t < limit; leg += 1) {
    if (leg > 0 && leg % 10 === 0) {
      const end = Math.min(t + 34 * H, limit);
      out.push({ kind: 'RESTART', start: t, end, driver: null });
      t = end;
      if (t >= limit) break;
    }
    const end = Math.min(t + 10.5 * H, limit);
    out.push({ kind: 'LEG', start: t, end, driver: leg % 2 === 0 ? 'A' : 'B' });
    t = end;
  }
  return out;
}

export function planDriver(rng: MockRng, input: PlanInput): Plan {
  return new Planner(rng, input).plan();
}

// ---------------------------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------------------------

/** The corrected (post-§9.3) timeline. */
export function applyEdits(segments: Seg[], edits: EditPlan[]): Seg[] {
  const out = segments.map((s) => ({ ...s }));
  for (const edit of edits) {
    const index = out.findIndex((s) => s.start === edit.start);
    if (index < 0) continue;
    const seg = out[index];
    if (edit.kind === 'INSERT_OFF') {
      out[index] = { ...seg, status: 'OFF', special: 'NONE', tag: 'REST' };
    } else if (edit.kind === 'RELABEL_SB') {
      out[index] = { ...seg, status: 'SB' };
    } else if (edit.kind === 'ADD_ON' && edit.end !== null && edit.end < seg.end) {
      out.splice(index, 1, { ...seg, status: 'ON', special: 'NONE', end: edit.end, tag: 'POST_TRIP' }, { ...seg, start: edit.end });
    }
  }
  return out;
}

/** One engine record per segment — the shape `mapEldEventsToNormalized` would produce. */
export function toEngineEvents(segments: Seg[]): NormalizedEvent[] {
  return segments.map((s, i) => ({ at: new Date(s.start), status: s.status, special: s.special, eventSequenceId: i + 1 }));
}

export interface DayTotals {
  off: number;
  sb: number;
  d: number;
  on: number;
}

/**
 * Per-RODS-day totals in seconds, the way `buildRodsDay` counts them: effective status,
 * the last segment runs on to `now`, a day with no record before it is OFF.
 */
export function dailyTotals(segments: Seg[], timezone: string, firstKey: string, lastKey: string, now: number): Map<string, DayTotals> {
  const result = new Map<string, DayTotals>();
  for (let key = firstKey; key <= lastKey; key = addDays(key, 1)) result.set(key, { off: 0, sb: 0, d: 0, on: 0 });
  const bound = (key: string): [number, number] => [fastDayStart(timezone, key), Math.min(now, fastDayStart(timezone, addDays(key, 1)))];

  const [firstStart] = bound(firstKey);
  if (segments.length === 0 || segments[0].start > firstStart) {
    const gapEnd = segments.length ? segments[0].start : now;
    addSpan(result, timezone, firstStart, gapEnd, 'OFF', firstKey, lastKey, bound);
  }
  segments.forEach((s, i) => {
    const end = i === segments.length - 1 ? Math.max(s.end, now) : s.end;
    addSpan(result, timezone, s.start, end, effective(s.status, s.special), firstKey, lastKey, bound);
  });
  return result;
}

function addSpan(
  result: Map<string, DayTotals>,
  timezone: string,
  start: number,
  end: number,
  status: DutyStatus,
  firstKey: string,
  lastKey: string,
  bound: (key: string) => [number, number],
): void {
  let from = start;
  while (from < end) {
    const key = fastDayKey(timezone, from);
    const [, dayEndMs] = bound(key);
    const nextDay = fastDayStart(timezone, addDays(key, 1));
    const to = Math.min(end, nextDay);
    if (key >= firstKey && key <= lastKey) {
      const sliceEnd = Math.min(to, dayEndMs);
      if (sliceEnd > from) {
        const totals = result.get(key);
        if (totals) {
          const sec = Math.round((sliceEnd - from) / 1000);
          if (status === 'OFF') totals.off += sec;
          else if (status === 'SB') totals.sb += sec;
          else if (status === 'D') totals.d += sec;
          else totals.on += sec;
        }
      }
    }
    from = to;
  }
}
