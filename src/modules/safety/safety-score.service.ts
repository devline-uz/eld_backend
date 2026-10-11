import { Injectable, Logger } from '@nestjs/common';
import { computeDriverScore } from './lib/harsh-detect';
import {
  dateKeyToDbDate,
  latestCompleteDay,
  periodEndingOn,
  periodInstants,
  previousPeriod,
  rankDrivers,
  type ScorePeriod,
} from './lib/scorecard';
import { SafetyRepository } from './safety.repository';

const HARSH_TYPES = new Set(['HARSH_BRAKING', 'HARSH_ACCEL', 'HARSH_TURN']);

export interface PeriodScoreResult {
  periodStart: string;
  periodEnd: string;
  drivers: number;
  scored: number;
  unscored: number;
}

export interface ScoreRunResult {
  current: PeriodScoreResult;
  previous: PeriodScoreResult;
}

/**
 * D-133 — W-10 Phase 1: computes `DriverScore` for the rolling 30-day period (and the 30 days
 * before it, the trend baseline) from SafetyEvent counts, DailyLog miles and HosViolation counts.
 * Read-only against the mobile-owned tables; it only writes `DriverScore`. Run nightly by the
 * worker (`safety-score.processor.ts`); never on an API request.
 */
@Injectable()
export class SafetyScoreService {
  private readonly logger = new Logger(SafetyScoreService.name);

  constructor(private readonly repo: SafetyRepository) {}

  /**
   * Scores the period ending on `endKey` ("YYYY-MM-DD", inclusive) — default: the newest day
   * that has ended in every driver's home-terminal zone at `now` — and re-scores the previous
   * period too, so the trend is available from the first run and reflects later dismissals.
   */
  async run(now: Date = new Date(), endKey?: string): Promise<ScoreRunResult> {
    const drivers = await this.repo.scoringDrivers();
    const end = endKey ?? latestCompleteDay(now, [...new Set(drivers.map((d) => d.homeTerminalTimezone))]);
    const current = periodEndingOn(end);
    const previous = previousPeriod(current);
    // Previous first: if the run dies half-way the API still shows the last complete period.
    const prev = await this.scorePeriod(previous, drivers);
    const cur = await this.scorePeriod(current, drivers);
    this.logger.log({ current: cur, previous: prev }, 'safety scorecard computed');
    return { current: cur, previous: prev };
  }

  async scorePeriod(
    period: ScorePeriod,
    drivers: Awaited<ReturnType<SafetyRepository['scoringDrivers']>>,
  ): Promise<PeriodScoreResult> {
    const fromDay = dateKeyToDbDate(period.startKey);
    const toDay = dateKeyToDbDate(period.endKey);
    const [miles, violations] = await Promise.all([
      this.repo.milesByDriver(fromDay, toDay),
      this.repo.hosViolationsByDriver(fromDay, toDay),
    ]);

    // SafetyEvent.occurredAt is an instant: bucket it by each driver's own home-terminal days.
    // One query per distinct zone, not per driver.
    const byZone = new Map<string, string[]>();
    for (const d of drivers) byZone.set(d.homeTerminalTimezone, [...(byZone.get(d.homeTerminalTimezone) ?? []), d.id]);
    const events = new Map<string, { harsh: Map<number, number>; speeding: number; seatbelt: number }>();
    for (const [tz, ids] of byZone) {
      const { from, to } = periodInstants(tz, period);
      for (const g of await this.repo.eventCountsForDrivers(ids, from, to)) {
        if (!g.driverId) continue;
        const e = events.get(g.driverId) ?? { harsh: new Map<number, number>(), speeding: 0, seatbelt: 0 };
        const n = g._count._all;
        if (HARSH_TYPES.has(g.type)) e.harsh.set(g.severity, (e.harsh.get(g.severity) ?? 0) + n);
        else if (g.type === 'SPEEDING') e.speeding += n;
        else if (g.type === 'SEATBELT') e.seatbelt += n;
        events.set(g.driverId, e);
      }
    }

    // ACTIVE drivers always get a row ("Not enough miles" when idle); an inactive one only when it
    // actually has activity in the period.
    const included = drivers.filter(
      (d) => d.status === 'ACTIVE' || (miles.get(d.id) ?? 0) > 0 || events.has(d.id) || violations.has(d.id),
    );
    const computed = included.map((d) => {
      const e = events.get(d.id);
      const harsh = [...(e?.harsh ?? new Map<number, number>())].map(([severity, count]) => ({ severity, count }));
      const milesDriven = miles.get(d.id) ?? 0;
      const violationCount = violations.get(d.id) ?? 0;
      const score = computeDriverScore({
        harsh,
        speedingCount: e?.speeding ?? 0,
        seatbeltCount: e?.seatbelt ?? 0,
        violationCount,
        milesDriven,
      });
      return {
        driverId: d.id,
        name: `${d.lastName}, ${d.firstName}`,
        score,
        milesDriven,
        harshCount: harsh.reduce((s, h) => s + h.count, 0),
        speedingCount: e?.speeding ?? 0,
        seatbeltCount: e?.seatbelt ?? 0,
        violationCount,
      };
    });
    const ranks = rankDrivers(computed);

    await this.repo.replacePeriodScores(
      fromDay,
      toDay,
      computed.map((c) => ({
        driverId: c.driverId,
        // `score` is NOT NULL in the schema (additive-only migration): an unscored row stores 0
        // with `scored = false`, and the API returns `score: null` for it.
        score: c.score ?? 0,
        scored: c.score !== null,
        harshCount: c.harshCount,
        speedingCount: c.speedingCount,
        seatbeltCount: c.seatbeltCount,
        milesDriven: c.milesDriven,
        violationCount: c.violationCount,
        rank: ranks.get(c.driverId) ?? null,
      })),
    );
    const scored = computed.filter((c) => c.score !== null).length;
    return { periodStart: period.startKey, periodEnd: period.endKey, drivers: computed.length, scored, unscored: computed.length - scored };
  }
}
