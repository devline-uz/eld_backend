import { Injectable } from '@nestjs/common';
import type { Trip, TripStop } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { TripPatchDto } from './dto/mobile-fleet-ops.dto';
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
    return toTripShape(trip, documents);
  }

  async patch(driverId: string, dto: TripPatchDto) {
    const trip = await this.resolveActiveTrip(driverId);
    if (!trip) {
      throw new AppException(ERROR_CODES.TRIP_NOT_FOUND, 'No active trip to update.', 404);
    }

    let trailerId: string | null | undefined;
    if (dto.trailerNumber !== undefined) {
      const trailer = await this.repo.findTrailerByNumber(dto.trailerNumber);
      if (!trailer) {
        throw new AppException(ERROR_CODES.TRAILER_NOT_FOUND, 'No trailer with that number exists.', 422, {
          trailerNumber: dto.trailerNumber,
        });
      }
      trailerId = trailer.id;
    }

    const updated = await this.repo.updateTrip(trip.id, {
      ...(dto.shippingDocument !== undefined && { shippingDocument: dto.shippingDocument }),
      ...(trailerId !== undefined && { trailerId }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
    });

    const documents = await this.documentsFor(driverId);
    return toTripShape(updated, documents);
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

function toTripShape(trip: Trip & { stops: TripStop[] }, documents: TripDocumentShape[]) {
  return {
    id: trip.id,
    number: trip.number,
    status: trip.status,
    vehicleId: trip.vehicleId,
    trailerId: trip.trailerId,
    shippingDocument: trip.shippingDocument,
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
