import { Injectable } from '@nestjs/common';
import type { Prisma, Trip, TripStop } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
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
@Injectable()
export class MobileTripService {
  constructor(private readonly repo: MobileFleetOpsRepository) {}

  async getActive(driverId: string) {
    const trip = await this.resolveActiveTrip(driverId);
    if (!trip) return null;

    const documents = await this.documentsFor(driverId);
    return this.toShape(trip, documents);
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

  async patch(driverId: string, dto: TripPatchDto) {
    const trip = await this.resolveActiveTrip(driverId);
    if (!trip) {
      throw new AppException(ERROR_CODES.TRIP_NOT_FOUND, 'No active trip to update.', 404);
    }

    const data: Prisma.TripUncheckedUpdateInput = {};

    // Shipping documents — the array wins over the single field; null/""/[] clear.
    if (dto.shippingDocuments !== undefined || dto.shippingDocument !== undefined) {
      const docs = dto.shippingDocuments ?? (dto.shippingDocument ? [dto.shippingDocument] : []);
      data.shippingDocuments = docs;
      data.shippingDocument = docs[0] ?? null;
    }

    // Trailers — BOBTAIL / bobtail:true = no trailer; null/""/[] clear; others must exist.
    const trailerTouched = dto.trailerNumbers !== undefined || dto.trailerNumber !== undefined || dto.bobtail !== undefined;
    if (trailerTouched) {
      const requested = dto.trailerNumbers ?? (dto.trailerNumber ? [dto.trailerNumber] : []);
      const real = requested.filter((n) => n.toUpperCase() !== BOBTAIL);
      const bobtail = dto.bobtail === true || requested.length !== real.length;
      if (bobtail && real.length > 0) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'A bobtail trip cannot also name a trailer.', 422, {
          issues: [{ path: 'trailerNumber', code: 'custom', message: 'BOBTAIL excludes real trailer numbers.' }],
        });
      }
      if (real.length > 0) {
        const found = await this.repo.findTrailersByNumbers(real);
        const byNumber = new Map(found.map((t) => [t.number, t]));
        const missing = real.filter((n) => !byNumber.has(n));
        if (missing.length > 0) {
          throw new AppException(ERROR_CODES.TRAILER_NOT_FOUND, 'No trailer with that number exists.', 422, {
            trailerNumber: missing[0],
            trailerNumbers: missing,
          });
        }
        data.trailerNumbers = real;
        data.trailerId = byNumber.get(real[0])!.id;
        data.bobtail = false;
      } else if (bobtail) {
        data.trailerNumbers = [];
        data.trailerId = null;
        data.bobtail = true;
      } else if (dto.bobtail === false && dto.trailerNumber === undefined && dto.trailerNumbers === undefined) {
        data.bobtail = false; // only un-declares bobtail; keeps whatever trailer is on the trip
      } else {
        data.trailerNumbers = [];
        data.trailerId = null;
        data.bobtail = false;
      }
    }

    if (dto.notes !== undefined) data.notes = dto.notes;

    const updated = await this.repo.updateTrip(trip.id, data);

    const documents = await this.documentsFor(driverId);
    return this.toShape(updated, documents);
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
