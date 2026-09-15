import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { EditorType, type HosViolation, type Prisma } from '@prisma/client';
import { AppException, ERROR_CODES } from '../../common/errors';
import { RequestContext, type ContextUser } from '../../core/context/request-context';
import { AuditRepository } from '../audit/audit.repository';
import { VIOLATION_WINDOWS, type ResolveViolationDto, type ViolationListQueryDto } from './dto/violations.dto';
import { ViolationsRepository, type ViolationWithDriver } from './violations.repository';

/** W-01 `EVENT` column wording (web/tz.md W-01 table). */
export const VIOLATION_EVENT_LABEL: Record<HosViolation['type'], string> = {
  DRIVING_11: '11-hour driving limit exceeded',
  SHIFT_14: '14-hour shift limit exceeded',
  BREAK_30: '30-minute break missed',
  CYCLE_70: '70-hour cycle limit exceeded',
  CYCLE_60: '60-hour cycle limit exceeded',
  FORM_MANNER: 'Form & manner error',
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * B-6 — fleet-wide `HosViolation` list and the manual resolve.
 *
 * Resolving is a status change on the VIOLATION row only: the RODS records that produced it are
 * never read for write, never superseded and never re-certified (§395.8 records are immutable
 * here; only §395.30 edits change them). Recalculation keeps the resolution (hos-violation-plan
 * rule 3) and only refreshes `exceededBySec`.
 */
@Injectable()
export class ViolationsService {
  private readonly logger = new Logger(ViolationsService.name);

  constructor(
    private readonly repo: ViolationsRepository,
    private readonly audit: AuditRepository,
  ) {}

  async list(query: ViolationListQueryDto, now: Date = new Date()) {
    const where = buildWhere(query, now);
    const { items, total } = await this.repo.list(where, query.page, query.limit);

    const contexts = await Promise.all(items.map((row) => this.repo.findContextEvent(row.driverId, row.occurredAt)));
    const vehicleIds = new Set<string>();
    items.forEach((row, i) => {
      const vehicleId = contexts[i]?.vehicleId ?? row.driver.assignedVehicleId;
      if (vehicleId) vehicleIds.add(vehicleId);
    });
    const units = new Map((await this.repo.findVehicles([...vehicleIds])).map((v) => [v.id, v.unitNumber]));

    return {
      items: items.map((row, i) => toListView(row, contexts[i] ?? null, units)),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.max(1, Math.ceil(total / query.limit)),
    };
  }

  async resolve(id: string, dto: ResolveViolationDto, actor: ContextUser) {
    const before = await this.repo.findById(id);
    if (!before) throw AppException.notFound('Violation not found.');
    if (before.status !== 'OPEN') {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        `Only an OPEN violation can be resolved; this one is ${before.status}.`,
        HttpStatus.CONFLICT,
        { status: before.status },
      );
    }

    const resolvedAt = new Date();
    const won = await this.repo.resolveIfOpen(id, { resolvedAt, resolvedById: actor.id, resolutionNote: dto.resolutionNote });
    if (!won) {
      throw new AppException(ERROR_CODES.CONFLICT, 'This violation was resolved or cleared concurrently.', HttpStatus.CONFLICT);
    }

    const ctx = RequestContext.get();
    // The resolution is a compliance decision: the audit row is part of the operation, not
    // best-effort — a failure here surfaces as a 500 rather than an unaudited resolve.
    await this.audit.insert({
      actorId: actor.id,
      actorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
      action: 'VIOLATION_RESOLVED',
      objectType: 'HosViolation',
      objectId: id,
      before: { status: before.status, resolvedAt: null, resolutionNote: null },
      after: { status: 'RESOLVED', resolvedAt: resolvedAt.toISOString(), resolvedById: actor.id, resolutionNote: dto.resolutionNote },
      detail: `${before.type} on ${day(before.logDate)} for driver ${before.driverId}`,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
    });
    this.logger.log({ violationId: id, actorId: actor.id }, 'HOS violation resolved');

    return { id, status: 'RESOLVED' as const, resolvedAt: resolvedAt.toISOString(), resolutionNote: dto.resolutionNote };
  }
}

export function buildWhere(query: ViolationListQueryDto, now: Date): Prisma.HosViolationWhereInput {
  const occurredAt: Prisma.DateTimeFilter = {};
  if (query.from || query.to) {
    if (query.from) occurredAt.gte = query.from;
    if (query.to) occurredAt.lte = query.to;
  } else if (query.window) {
    occurredAt.gte = new Date(now.getTime() - VIOLATION_WINDOWS[query.window] * 3_600_000);
  }
  return {
    ...(query.status !== 'ALL' && { status: query.status }),
    ...(query.driverId && { driverId: query.driverId }),
    ...(query.type && { type: query.type }),
    ...(Object.keys(occurredAt).length && { occurredAt }),
  };
}

export function toListView(
  row: ViolationWithDriver,
  context: { vehicleId: string | null; locationName: string | null } | null,
  units: Map<string, string>,
) {
  const vehicleId = context?.vehicleId ?? row.driver.assignedVehicleId ?? null;
  return {
    // HosViolation (web `shared/api/hosLogs.ts`)
    id: row.id,
    driverId: row.driverId,
    dailyLogId: row.dailyLogId,
    logDate: day(row.logDate),
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    exceededBySec: row.exceededBySec,
    detail: row.detail,
    status: row.status,
    resolvedAt: iso(row.resolvedAt),
    resolvedById: row.resolvedById,
    resolutionNote: row.resolutionNote,
    // W-01 dashboard row (web `DashboardPage.tsx` `Violation`)
    severity: 'VIOLATION' as const,
    driverName: `${row.driver.firstName} ${row.driver.lastName}`.trim(),
    vehicleId,
    unitNumber: vehicleId ? (units.get(vehicleId) ?? null) : null,
    event: VIOLATION_EVENT_LABEL[row.type],
    locationLabel: context?.locationName ?? null,
    date: day(row.logDate),
  };
}
