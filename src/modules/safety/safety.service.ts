import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage } from '../../common/dto/list-query.dto';
import { addDays, dayDiff } from '../hos/engine/timezone';
import { MIN_SCORED_MILES } from './lib/harsh-detect';
import { dateKeyToDbDate, dbDateToKey, fleetScore, periodEndingOn, SCORE_ATTENTION_THRESHOLD, scoreTrend } from './lib/scorecard';
import { AssignCoachingDto, ScorecardQueryDto, SafetyEventListQueryDto, UpdateSafetyEventDto } from './dto/safety.dto';
import { SafetyRepository } from './safety.repository';

@Injectable()
export class SafetyService {
  constructor(private readonly repo: SafetyRepository) {}

  async listEvents(query: SafetyEventListQueryDto): Promise<OffsetPage<unknown>> {
    const { items, total } = await this.repo.list(
      { driverId: query.driverId, vehicleId: query.vehicleId, type: query.type, status: query.status, from: query.from, to: query.to },
      query.page,
      query.limit,
    );
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) };
  }

  /** §20 B-43 — `dto.driverId` assigns coaching at the driver level: the most recent
   * not-yet-coached event for that driver is coached, so the caller never has to hunt down a
   * specific event first. `dto.eventId` keeps the existing event-driven flow. */
  async coach(dto: AssignCoachingDto, coachedById: string) {
    const eventId = dto.eventId ?? (await this.findEventIdForDriver(dto.driverId!));
    const event = await this.repo.findById({ id: eventId });
    if (!event) throw new AppException(ERROR_CODES.NOT_FOUND, 'Safety event not found.', 404);
    return this.repo.update(
      { id: eventId },
      { status: 'COACHED', coachedById, coachedAt: new Date(), coachingNote: dto.note },
    );
  }

  private async findEventIdForDriver(driverId: string): Promise<string> {
    const event = await this.repo.findLatestOpenForDriver(driverId);
    if (!event) throw new AppException(ERROR_CODES.NOT_FOUND, 'No open safety event for this driver to coach.', 404);
    return event.id;
  }

  async updateEvent(id: string, dto: UpdateSafetyEventDto) {
    const event = await this.repo.findById({ id });
    if (!event) throw new AppException(ERROR_CODES.NOT_FOUND, 'Safety event not found.', 404);
    return this.repo.update({ id }, dto);
  }

  /**
   * TZ eld.docs/web §9 — "Fleet safety score, driver scorecard sorted by rank". D-141: reads the
   * already-computed `DriverScore` rows (nightly `safety-score` job) — it never recomputes on a
   * GET, so the numbers a fleet manager reviews stay stable within a day.
   *
   * No query -> the LATEST computed period (max `periodEnd`). `periodStart` (or `periodEnd`)
   * selects a specific stored period. The baseline is the stored period of the same length
   * ending the day before (§20 B-44 `previousScore`/`trend` per row; D-141 fleet trend).
   */
  async scorecard(query: ScorecardQueryDto): Promise<ScorecardResult> {
    const period = await this.resolvePeriod(query);
    if (!period) {
      return { periodStart: null, periodEnd: null, computedAt: null, minMiles: MIN_SCORED_MILES, fleet: emptyFleet(), items: [] };
    }
    const lengthDays = dayDiff(period.endKey, period.startKey) + 1;
    const prevStartKey = addDays(period.startKey, -lengthDays);

    const [rows, previousRows] = await Promise.all([
      this.repo.scorecard(dateKeyToDbDate(period.startKey)),
      this.repo.scorecard(dateKeyToDbDate(prevStartKey)),
    ]);
    const previousByDriver = new Map(previousRows.filter((r) => r.scored).map((r) => [r.driverId, r.score]));

    const items: ScorecardItem[] = rows.map((row) => {
      const score = row.scored ? row.score : null;
      const previousScore = previousByDriver.get(row.driverId) ?? null;
      return {
        id: row.id,
        driverId: row.driverId,
        periodStart: dbDateToKey(row.periodStart),
        periodEnd: dbDateToKey(row.periodEnd),
        score,
        scored: row.scored,
        harshCount: row.harshCount,
        speedingCount: row.speedingCount,
        seatbeltCount: row.seatbeltCount,
        milesDriven: row.milesDriven,
        violationCount: row.violationCount,
        rank: row.scored ? row.rank : null,
        previousScore,
        trend: scoreTrend(score, previousScore),
        computedAt: row.computedAt.toISOString(),
      };
    });

    const currentFleet = fleetScore(items);
    const previousFleet = fleetScore(previousRows.map((r) => ({ score: r.scored ? r.score : null, milesDriven: r.milesDriven })));
    const scored = items.filter((i) => i.score !== null);
    const computedAt = rows.reduce<Date | null>((max, r) => (!max || r.computedAt > max ? r.computedAt : max), null);
    return {
      periodStart: period.startKey,
      periodEnd: period.endKey,
      computedAt: computedAt ? computedAt.toISOString() : null,
      minMiles: MIN_SCORED_MILES,
      fleet: {
        score: currentFleet,
        previousScore: previousFleet,
        trend: scoreTrend(currentFleet, previousFleet),
        scoredDrivers: scored.length,
        unscoredDrivers: items.length - scored.length,
        belowThresholdCount: scored.filter((i) => (i.score as number) < SCORE_ATTENTION_THRESHOLD).length,
        milesDriven: scored.reduce((sum, i) => sum + i.milesDriven, 0),
      },
      items: sortScorecard(items),
    };
  }

  private async resolvePeriod(query: ScorecardQueryDto): Promise<{ startKey: string; endKey: string } | null> {
    if (query.periodStart) {
      const rows = await this.repo.scorecard(dateKeyToDbDate(query.periodStart));
      return rows.length > 0 ? { startKey: query.periodStart, endKey: dbDateToKey(rows[0].periodEnd) } : null;
    }
    if (query.periodEnd) return periodEndingOn(query.periodEnd);
    const latest = await this.repo.latestPeriod();
    return latest ? { startKey: dbDateToKey(latest.periodStart), endKey: dbDateToKey(latest.periodEnd) } : null;
  }
}

export interface ScorecardItem {
  id: string;
  driverId: string;
  periodStart: string;
  periodEnd: string;
  /** null = fewer than `minMiles` in the period ("Not enough miles"). */
  score: number | null;
  scored: boolean;
  harshCount: number;
  speedingCount: number;
  seatbeltCount: number;
  milesDriven: number;
  violationCount: number;
  rank: number | null;
  previousScore: number | null;
  trend: number | null;
  computedAt: string;
}

export interface ScorecardFleet {
  /** Mile-weighted mean of scored drivers. */
  score: number | null;
  previousScore: number | null;
  trend: number | null;
  scoredDrivers: number;
  unscoredDrivers: number;
  /** Scored drivers below 70 ("needs attention"). */
  belowThresholdCount: number;
  milesDriven: number;
}

export interface ScorecardResult {
  periodStart: string | null;
  periodEnd: string | null;
  computedAt: string | null;
  minMiles: number;
  fleet: ScorecardFleet;
  items: ScorecardItem[];
}

function emptyFleet(): ScorecardFleet {
  return { score: null, previousScore: null, trend: null, scoredDrivers: 0, unscoredDrivers: 0, belowThresholdCount: 0, milesDriven: 0 };
}

/** Ranked rows by rank; then unscored rows by miles desc, then driverId. */
export function sortScorecard(items: ScorecardItem[]): ScorecardItem[] {
  return [...items].sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return b.milesDriven - a.milesDriven || a.driverId.localeCompare(b.driverId);
  });
}
