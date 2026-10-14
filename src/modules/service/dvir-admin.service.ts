import { Injectable } from '@nestjs/common';
import type { Defect, Dvir } from '@prisma/client';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { FUTURE_SKEW_MS } from './defect-rules';
import { dayEnd, dayKey, dayStart } from '../hos/engine/timezone';
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
    // CODE-074 — a "day" is the carrier's calendar day, not the UTC one: a 7 PM pre-trip in
    // Denver is filed on the NEXT UTC day, so UTC buckets showed a day as missing and the
    // following one as covered twice.
    const timezone = await this.repo.carrierTimezone();
    const from = dayStart(timezone, query.from);
    const to = new Date(dayEnd(timezone, query.to).getTime() - 1);
    const [vehicles, submissions] = await Promise.all([this.repo.activeVehicles(), this.repo.submittedPreTrips(from, to)]);

    const days = enumerateDates(query.from, query.to);
    const submittedKeys = new Set(submissions.map((s) => `${s.vehicleId}:${dayKey(timezone, s.submittedAt)}`));

    let expected = 0;
    let submitted = 0;
    const missing: Array<{ vehicleId: string; unitNumber: string; date: string }> = [];

    for (const vehicle of vehicles) {
      // A unit cannot owe a pre-trip for a day before it was added to the fleet — a unit created
      // today used to show a "Missing pre-trip" row for every day of the range.
      const firstDay = vehicle.createdAt ? dayKey(timezone, vehicle.createdAt) : null;
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
    return { expected, submitted, compliancePct, missing, timezone };
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


  /**
   * QA CODE-035 — §396.11(a)(3) sign-off certifies the defects were repaired, deferred or needed no
   * repair: it is signed once (the web form is only offered while unsigned), never as `PENDING`,
   * and `REPAIRED` needs at least one defect and none still OPEN / IN_PROGRESS. The time is the
   * server's, so it can never be in the future.
   */
  async mechanicSignOff(id: string, dto: MechanicSignOffDto): Promise<Dvir> {
    const dvir = await this.get(id);
    if (dvir.mechanicSignedAt) {
      throw new AppException(ERROR_CODES.DVIR_ALREADY_SIGNED, 'This DVIR is already signed off.', 409, { id });
    }
    const blocked = signOffBlockReason(dvir.defects, dto.repairStatus);
    if (blocked) throw new AppException(ERROR_CODES.VALIDATION_FAILED, blocked, 422, { repairStatus: blocked });
    return this.repo.update(
      { id },
      { mechanicName: dto.mechanicName, mechanicNote: dto.mechanicNote ?? null, mechanicSignedAt: new Date(), repairStatus: dto.repairStatus },
    );
  }

  /**
   * QA CODE-035 — §396.13(b) the next driver reviews the previous DVIR (and, when it listed defects,
   * the mechanic's certification): a DVIR with defects is reviewed only after the sign-off, once,
   * and the review time is neither in the future nor before the DVIR / sign-off.
   */
  async nextDriverReview(id: string, dto: NextDriverReviewDto): Promise<Dvir> {
    const dvir = await this.get(id);
    if (dvir.nextDriverReviewedAt) {
      throw new AppException(ERROR_CODES.CONFLICT, 'This DVIR was already reviewed by the next driver.', 409, { id });
    }
    if (dvir.defects.length > 0 && !dvir.mechanicSignedAt) {
      throw new AppException(ERROR_CODES.CONFLICT, 'The DVIR lists defects and has no mechanic sign-off yet.', 409, { id });
    }
    const now = new Date();
    const reviewedAt = dto.reviewedAt ? new Date(dto.reviewedAt) : now;
    const earliest = dvir.mechanicSignedAt ?? dvir.submittedAt;
    let message: string | null = null;
    if (reviewedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) message = 'Review time cannot be in the future.';
    else if (earliest && reviewedAt.getTime() < earliest.getTime()) message = 'Review time cannot be before the DVIR or its sign-off.';
    if (message) throw new AppException(ERROR_CODES.VALIDATION_FAILED, message, 422, { reviewedAt: message });
    return this.repo.update({ id }, { nextDriverReviewedAt: reviewedAt });
  }
}

/** QA CODE-035 — why this repair status cannot be signed for these defects, or `null` if it can. */
export function signOffBlockReason(defects: ReadonlyArray<Pick<Defect, 'status'>>, repairStatus: Dvir['repairStatus']): string | null {
  if (repairStatus === 'PENDING') return 'A sign-off must certify the defects as repaired, deferred or not needing repair.';
  if (repairStatus === 'REPAIRED') {
    if (defects.length === 0) return 'This DVIR lists no defects — sign it off as "Not required".';
    if (defects.some((d) => d.status === 'OPEN' || d.status === 'IN_PROGRESS')) {
      return 'Resolve or defer every open defect before signing the DVIR off as repaired.';
    }
  }
  return null;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive `YYYY-MM-DD` list from `from` to `to`. The DTO refuses a window over 366 days
 * (CODE-074), so the guard below never cuts a request short silently. */
function enumerateDates(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  const days: string[] = [];
  for (let d = start; d <= end && days.length < 366; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    days.push(toDateKey(d));
  }
  return days;
}
