import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage } from '../../common/dto/list-query.dto';
import { computeDriverScore } from './lib/harsh-detect';
import { AssignCoachingDto, ScorecardQueryDto, SafetyEventListQueryDto, UpdateSafetyEventDto } from './dto/safety.dto';
import { SafetyRepository } from './safety.repository';

const HARSH_TYPES = new Set(['HARSH_BRAKING', 'HARSH_ACCEL', 'HARSH_TURN']);

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

  async coach(dto: AssignCoachingDto, coachedById: string) {
    const event = await this.repo.findById({ id: dto.eventId });
    if (!event) throw new AppException(ERROR_CODES.NOT_FOUND, 'Safety event not found.', 404);
    return this.repo.update(
      { id: dto.eventId },
      { status: 'COACHED', coachedById, coachedAt: new Date(), coachingNote: dto.note },
    );
  }

  async updateEvent(id: string, dto: UpdateSafetyEventDto) {
    const event = await this.repo.findById({ id });
    if (!event) throw new AppException(ERROR_CODES.NOT_FOUND, 'Safety event not found.', 404);
    return this.repo.update({ id }, dto);
  }

  /**
   * TZ eld.docs/web §9 — "Fleet safety score, driver scorecard sorted by rank". Reads the
   * already-computed `DriverScore` rows for the period (nightly-computed in production);
   * this endpoint only ranks and returns them — it never recomputes on a GET, so the
   * numbers a fleet manager reviews stay stable within a session.
   */
  async scorecard(query: ScorecardQueryDto) {
    const periodEnd = query.periodEnd ?? new Date();
    const periodStart = query.periodStart ?? new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rows = await this.repo.scorecard(periodStart, periodEnd);
    return { items: rows, periodStart, periodEnd };
  }

  /**
   * Recomputes `DriverScore` for one driver/period from `SafetyEvent` counts
   * (`computeDriverScore`, safety/lib/harsh-detect.ts — documented D-0xx). Called by the
   * nightly retention/scoring sweep and available here for on-demand recompute.
   */
  async recomputeScore(driverId: string, periodStart: Date, periodEnd: Date, milesDriven: number, violationCount: number) {
    const groups = await this.repo.countsForDriver(driverId, periodStart, periodEnd);
    let harshCount = 0;
    let speedingCount = 0;
    for (const g of groups) {
      if (HARSH_TYPES.has(g.type)) harshCount += g._count._all;
      if (g.type === 'SPEEDING') speedingCount += g._count._all;
    }
    const score = computeDriverScore({ harshCount, speedingCount, milesDriven, violationCount });
    return this.repo.upsertScore(driverId, periodStart, periodEnd, {
      score,
      harshCount,
      speedingCount,
      milesDriven,
      violationCount,
    });
  }
}
