import { Injectable, Logger } from '@nestjs/common';
import { EditorType } from '@prisma/client';
import type { DriverDayDetails, Prisma, Trip, TripStop } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { RequestContext } from '../../core/context/request-context';
import { AuditRepository } from '../audit/audit.repository';
import { addDays, dayKey } from '../hos/engine/timezone';
import { BOBTAIL, type TripPatchDto } from './dto/mobile-fleet-ops.dto';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';

/** Sub-set of `Trip` used as the mobile "document" (BOL/shipping-doc) summary — M-05/P-03. */
export interface TripDocumentShape {
  tripId: string;
  number: string;
  shippingDocument: string | null;
  commodity: string | null;
  pieces: number | null;
  weightLbs: number | null;
}

/**
 * mobile/tz.md §21.1 MB-5, screens M-05/S-05/P-03 — the driver's active trip.
 *
 * "Active" mirrors the app's own resolution order: an `IN_PROGRESS` trip, else the next
 * `ASSIGNED` one. `TripStatus` has no `COMPLETED` value — `DELIVERED`/`CANCELLED` are the
 * only terminal states, so "non-completed" below means "not one of those two".
 */
/** D-129 — the driver-editable trip fields, resolved once and written to a Trip OR a day-details row. */
interface TripFieldChanges {
  shippingDocuments?: string[];
  trailerNumbers?: string[];
  trailerId?: string | null;
  bobtail?: boolean;
  notes?: string | null;
}

/** D-129 — how far back the app may write a day-details row (the §13 offline window). */
export const DAY_DETAILS_MAX_AGE_DAYS = 30;

@Injectable()
export class MobileTripService {
  private readonly logger = new Logger(MobileTripService.name);

  constructor(
    private readonly repo: MobileFleetOpsRepository,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * The active trip (`source: "TRIP"`), else — D-129 — the driver's day details for `date`
   * (home-terminal RODS day, default today) with `source: "DAY_DETAILS"`, `id: null`. Never null:
   * with no trip and no stored day details the lists are empty.
   */
  async getActive(driverId: string, date?: string) {
    const trip = await this.resolveActiveTrip(driverId);
    const documents = await this.documentsFor(driverId);
    if (trip) return this.toShape(trip, documents);

    const logDate = await this.resolveLogDate(driverId, date);
    const details = await this.repo.findDayDetails(driverId, utcDate(logDate));
    return toDayDetailsShape(logDate, details, documents);
  }

  /** MR-15 — the trip's multi-value lists for the co-driver card; `null` when no active trip. */
  async activeTripLists(driverId: string): Promise<{ shippingDocuments: string[]; trailerNumbers: string[] } | null> {
    const trip = await this.resolveActiveTrip(driverId);
    if (!trip) return null;
    const lists = await this.listsOf(trip);
    return { shippingDocuments: lists.shippingDocuments, trailerNumbers: lists.trailerNumbers };
  }

  /** MR-8 — `GET /mobile/trailers?q=`: the carrier's live ACTIVE trailers. */
  async listTrailers(q: string | undefined, limit = 50) {
    const trailers = await this.repo.listActiveTrailers(q, limit);
    return trailers.map((t) => ({ id: t.id, number: t.number, plate: null as string | null }));
  }

  /**
   * MR-4 / D-129 — updates the active trip; with NO active trip the same fields are written to the
   * driver's day details for `dto.logDate` (default: today, home-terminal day) instead of 404.
   */
  async patch(driverId: string, dto: TripPatchDto) {
    const trip = await this.resolveActiveTrip(driverId);
    const changes = await this.changesFrom(dto);

    if (!trip) return this.patchDayDetails(driverId, dto.logDate, changes);

    const data: Prisma.TripUncheckedUpdateInput = {};
    if (changes.shippingDocuments !== undefined) {
      data.shippingDocuments = changes.shippingDocuments;
      data.shippingDocument = changes.shippingDocuments[0] ?? null;
    }
    if (changes.trailerNumbers !== undefined) data.trailerNumbers = changes.trailerNumbers;
    if (changes.trailerId !== undefined) data.trailerId = changes.trailerId;
    if (changes.bobtail !== undefined) data.bobtail = changes.bobtail;
    if (changes.notes !== undefined) data.notes = changes.notes;

    const updated = await this.repo.updateTrip(trip.id, data);

    const documents = await this.documentsFor(driverId);
    return this.toShape(updated, documents);
  }

  private async patchDayDetails(driverId: string, requestedDate: string | undefined, changes: TripFieldChanges) {
    const logDate = await this.resolveLogDate(driverId, requestedDate);
    const before = await this.repo.findDayDetails(driverId, utcDate(logDate));
    const saved = await this.repo.upsertDayDetails(driverId, utcDate(logDate), changes);

    // §395.8(d) header data is part of the day's log: changing it on a certified day requires
    // re-certification (tz.md §9.2 "any change to a log requires re-certification").
    const decertified = sameDetails(before, saved) ? 0 : await this.repo.dropCertification(driverId, utcDate(logDate));
    await this.writeAudit(driverId, logDate, before, saved, decertified > 0);

    const documents = await this.documentsFor(driverId);
    return toDayDetailsShape(logDate, saved, documents);
  }

  /** Normalizes the request once: documents, trailers (free text, linked when ACTIVE), bobtail, notes. */
  private async changesFrom(dto: TripPatchDto): Promise<TripFieldChanges> {
    const out: TripFieldChanges = {};

    // Shipping documents — the array wins over the single field; null/""/[] clear.
    if (dto.shippingDocuments !== undefined || dto.shippingDocument !== undefined) {
      out.shippingDocuments = unique(dto.shippingDocuments ?? (dto.shippingDocument ? [dto.shippingDocument] : []));
    }

    // Trailers — BOBTAIL / bobtail:true = no trailer; null/""/[] clear. D-129: any other number is
    // accepted as free text (already upper-cased and 7.42-checked by the DTO) and LINKED when it
    // matches an ACTIVE carrier trailer — no 422 TRAILER_NOT_FOUND any more.
    const trailerTouched = dto.trailerNumbers !== undefined || dto.trailerNumber !== undefined || dto.bobtail !== undefined;
    if (trailerTouched) {
      const requested = dto.trailerNumbers ?? (dto.trailerNumber ? [dto.trailerNumber] : []);
      const real = unique(requested.map((n) => n.toUpperCase()).filter((n) => n !== BOBTAIL));
      const bobtail = dto.bobtail === true || requested.some((n) => n.toUpperCase() === BOBTAIL);
      if (bobtail && real.length > 0) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'A bobtail trip cannot also name a trailer.', 422, {
          issues: [{ path: 'trailerNumber', code: 'custom', message: 'BOBTAIL excludes real trailer numbers.' }],
        });
      }
      if (real.length > 0) {
        const found = await this.repo.findTrailersByNumbers(real);
        const byNumber = new Map(found.map((t) => [t.number.toUpperCase(), t]));
        const linked = real.find((n) => byNumber.has(n));
        out.trailerNumbers = real;
        out.trailerId = linked ? byNumber.get(linked)!.id : null;
        out.bobtail = false;
      } else if (bobtail) {
        out.trailerNumbers = [];
        out.trailerId = null;
        out.bobtail = true;
      } else if (dto.bobtail === false && dto.trailerNumber === undefined && dto.trailerNumbers === undefined) {
        out.bobtail = false; // only un-declares bobtail; keeps whatever trailer is recorded
      } else {
        out.trailerNumbers = [];
        out.trailerId = null;
        out.bobtail = false;
      }
    }

    if (dto.notes !== undefined) out.notes = dto.notes;
    return out;
  }

  /** Home-terminal RODS day key; a requested day must be today or within the offline window. */
  private async resolveLogDate(driverId: string, requested: string | undefined): Promise<string> {
    const driver = await this.repo.findDriverTimezone(driverId);
    const today = dayKey(driver?.homeTerminalTimezone ?? 'UTC', new Date());
    if (!requested) return today;
    if (requested > today || requested < addDays(today, -DAY_DETAILS_MAX_AGE_DAYS)) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, `logDate must be between ${addDays(today, -DAY_DETAILS_MAX_AGE_DAYS)} and ${today}.`, 422, {
        issues: [{ path: 'logDate', code: 'custom', message: `Not within the last ${DAY_DETAILS_MAX_AGE_DAYS} days.` }],
      });
    }
    return requested;
  }

  private async writeAudit(
    driverId: string,
    logDate: string,
    before: DriverDayDetails | null,
    after: DriverDayDetails,
    decertified: boolean,
  ): Promise<void> {
    const ctx = RequestContext.get();
    try {
      await this.audit.insert({
        actorId: driverId,
        actorType: EditorType.DRIVER,
        action: 'DRIVER_DAY_DETAILS_UPDATED',
        objectType: 'DriverDayDetails',
        objectId: after.id,
        before: before ? (detailsSnapshot(before)) : undefined,
        after: { ...detailsSnapshot(after), logDate, certificationDropped: decertified },
        detail: 'Driver set shipping documents / trailers for a RODS day with no active trip (D-129).',
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, driverId, logDate }, 'Failed to write the day-details audit entry');
    }
  }

  /** Multi-value lists with a fallback to the legacy single columns for pre-MR-4 rows. */
  private async listsOf(trip: Trip) {
    const shippingDocuments = trip.shippingDocuments?.length ? trip.shippingDocuments : trip.shippingDocument ? [trip.shippingDocument] : [];
    let trailerNumbers = trip.trailerNumbers ?? [];
    if (trailerNumbers.length === 0 && trip.trailerId) {
      const trailer = await this.repo.findTrailerById(trip.trailerId);
      if (trailer) trailerNumbers = [trailer.number];
    }
    return { shippingDocuments, trailerNumbers };
  }

  private async toShape(trip: Trip & { stops: TripStop[] }, documents: TripDocumentShape[]) {
    const lists = await this.listsOf(trip);
    return toTripShape(trip, documents, lists);
  }

  private async resolveActiveTrip(driverId: string): Promise<(Trip & { stops: TripStop[] }) | null> {
    return (await this.repo.findActiveTrip(driverId)) ?? (await this.repo.findNextAssignedTrip(driverId));
  }

  private async documentsFor(driverId: string): Promise<TripDocumentShape[]> {
    const trips = await this.repo.findNonCompletedTrips(driverId);
    return trips.map((trip) => ({
      tripId: trip.id,
      number: trip.number,
      shippingDocument: trip.shippingDocument,
      commodity: trip.commodity,
      pieces: trip.pieces,
      weightLbs: trip.weightLbs,
    }));
  }
}

function toTripShape(
  trip: Trip & { stops: TripStop[] },
  documents: TripDocumentShape[],
  lists: { shippingDocuments: string[]; trailerNumbers: string[] },
) {
  return {
    /** D-129 — `TRIP` here; `DAY_DETAILS` when there is no active trip. */
    source: 'TRIP' as const,
    id: trip.id,
    number: trip.number,
    status: trip.status,
    vehicleId: trip.vehicleId,
    trailerId: trip.trailerId,
    shippingDocument: trip.shippingDocument,
    shippingDocuments: lists.shippingDocuments,
    trailerNumber: lists.trailerNumbers[0] ?? null,
    trailerNumbers: lists.trailerNumbers,
    bobtail: trip.bobtail,
    commodity: trip.commodity,
    weightLbs: trip.weightLbs,
    pieces: trip.pieces,
    plannedStartAt: trip.plannedStartAt,
    plannedEndAt: trip.plannedEndAt,
    startedAt: trip.startedAt,
    completedAt: trip.completedAt,
    etaAt: trip.etaAt,
    onTime: trip.onTime,
    notes: trip.notes,
    stops: trip.stops.map((stop) => ({
      id: stop.id,
      sequence: stop.sequence,
      type: stop.type,
      name: stop.name,
      address: stop.address,
      latitude: stop.latitude,
      longitude: stop.longitude,
      scheduledAt: stop.scheduledAt,
      arrivedAt: stop.arrivedAt,
      departedAt: stop.departedAt,
      status: stop.status,
      note: stop.note,
    })),
    documents,
  };
}

/** D-129 — `GET`/`PATCH /mobile/trip` with no active trip: the same field names as the trip shape. */
function toDayDetailsShape(logDate: string, details: DriverDayDetails | null, documents: TripDocumentShape[]) {
  const shippingDocuments = details?.shippingDocuments ?? [];
  const trailerNumbers = details?.trailerNumbers ?? [];
  return {
    source: 'DAY_DETAILS' as const,
    id: null,
    trip: null,
    logDate,
    shippingDocument: shippingDocuments[0] ?? null,
    shippingDocuments,
    trailerId: details?.trailerId ?? null,
    trailerNumber: trailerNumbers[0] ?? null,
    trailerNumbers,
    bobtail: details?.bobtail ?? false,
    notes: details?.notes ?? null,
    updatedAt: details?.updatedAt ?? null,
    stops: [] as never[],
    documents,
  };
}

function detailsSnapshot(d: DriverDayDetails) {
  return { shippingDocuments: d.shippingDocuments, trailerNumbers: d.trailerNumbers, trailerId: d.trailerId, bobtail: d.bobtail, notes: d.notes };
}

function sameDetails(a: DriverDayDetails | null, b: DriverDayDetails): boolean {
  if (!a) return b.shippingDocuments.length === 0 && b.trailerNumbers.length === 0 && !b.bobtail && !b.notes;
  return JSON.stringify(detailsSnapshot(a)) === JSON.stringify(detailsSnapshot(b));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** `YYYY-MM-DD` -> the UTC-midnight `Date` Prisma stores in a `@db.Date` column. */
function utcDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}
