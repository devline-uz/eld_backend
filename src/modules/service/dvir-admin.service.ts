import { Injectable } from '@nestjs/common';
import type { Dvir } from '@prisma/client';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { DvirAdminRepository } from './dvir-admin.repository';
import { DvirPdfBuilder } from './dvir-pdf.builder';
import { DvirComplianceQueryDto, DvirListQueryDto, MechanicSignOffDto, NextDriverReviewDto } from './dto/service.dto';

const SORTABLE_FIELDS = ['submittedAt', 'repairStatus', 'createdAt'] as const;

/** TZ §5.10 / §396.13 — web read of DVIRs plus the mechanic sign-off + next-driver-review
 * steps that complete the paper trail the driver app submission starts. */
@Injectable()
export class DvirAdminService {
  constructor(
    private readonly repo: DvirAdminRepository,
    private readonly pdf: DvirPdfBuilder,
  ) {}

  async list(query: DvirListQueryDto): Promise<OffsetPage<Dvir>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { submittedAt: 'desc' });
    const { items, total } = await this.repo.list(
      {
        vehicleId: query.vehicleId,
        driverId: query.driverId,
        repairStatus: query.repairStatus,
        from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
        to: query.to ? new Date(`${query.to}T23:59:59.999Z`) : undefined,
      },
      query.page,
      query.limit,
      orderBy,
    );
    return toOffsetPage(items, total, query.page, query.limit);
  }

  /**
   * §20 B-47 `GET /dvir/compliance` — "expected" is one PRE_TRIP DVIR per ACTIVE vehicle per
   * calendar day in `[from, to]` (TZ §5.10 daily pre-trip requirement); "submitted" counts each
   * vehicle/day with at least one PRE_TRIP DVIR actually on file. `missing` lists the gaps
   * (W-14 "Missing pre-trip" rows), capped at 500 rows so a wide date range on a large fleet
   * still returns a bounded payload.
   */
  async compliance(query: DvirComplianceQueryDto) {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to}T23:59:59.999Z`);
    const [vehicles, submissions] = await Promise.all([this.repo.activeVehicles(), this.repo.submittedPreTrips(from, to)]);

    const days = enumerateDates(query.from, query.to);
    const submittedKeys = new Set(submissions.map((s) => `${s.vehicleId}:${toDateKey(s.submittedAt)}`));

    let expected = 0;
    let submitted = 0;
    const missing: Array<{ vehicleId: string; unitNumber: string; date: string }> = [];

    for (const vehicle of vehicles) {
      // A unit cannot owe a pre-trip for a day before it was added to the fleet — a unit created
      // today used to show a "Missing pre-trip" row for every day of the range.
      const firstDay = vehicle.createdAt ? toDateKey(vehicle.createdAt) : null;
      for (const date of days) {
        if (firstDay && date < firstDay) continue;
        expected += 1;
        if (submittedKeys.has(`${vehicle.id}:${date}`)) {
          submitted += 1;
        } else if (missing.length < 500) {
          missing.push({ vehicleId: vehicle.id, unitNumber: vehicle.unitNumber, date });
        }
      }
    }

    const compliancePct = expected === 0 ? 100 : Math.round((submitted / expected) * 1000) / 10;
    return { expected, submitted, compliancePct, missing };
  }

  async get(id: string) {
    const dvir = await this.repo.findWithDefects(id);
    if (!dvir) throw new AppException(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.', 404, { id });
    return dvir;
  }

  /** B-75 — `GET /dvir/:id/pdf`: §396.11 inspection record, defects and both signatures for
   * ONE DVIR, rendered on demand (a single-page print artifact, not a queued `Report` job —
   * §15's "never generated inside a request" rule is about bulk exports/CSV-PDF report jobs;
   * this is the same class of on-request PDF as `mobile-logs-export.service.ts`'s per-day
   * export). */
  async getPdf(id: string): Promise<Buffer> {
    const dvir = await this.repo.findForPdf(id);
    if (!dvir) throw new AppException(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.', 404, { id });
    return this.pdf.build(dvir);
  }

  private async getOrThrow(id: string): Promise<Dvir> {
    const dvir = await this.repo.findById({ id });
    if (!dvir) throw new AppException(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.', 404, { id });
    return dvir;
  }

  async mechanicSignOff(id: string, dto: MechanicSignOffDto): Promise<Dvir> {
    await this.getOrThrow(id);
    return this.repo.update(
      { id },
      { mechanicName: dto.mechanicName, mechanicNote: dto.mechanicNote ?? null, mechanicSignedAt: new Date(), repairStatus: dto.repairStatus },
    );
  }

  async nextDriverReview(id: string, dto: NextDriverReviewDto): Promise<Dvir> {
    await this.getOrThrow(id);
    return this.repo.update({ id }, { nextDriverReviewedAt: dto.reviewedAt ? new Date(dto.reviewedAt) : new Date() });
  }
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive `YYYY-MM-DD` list from `from` to `to`. Capped at 366 days — a compliance query
 * spanning more than a year is almost certainly a caller mistake, not a real report window. */
function enumerateDates(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  const days: string[] = [];
  for (let d = start; d <= end && days.length < 366; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    days.push(toDateKey(d));
  }
  return days;
}
