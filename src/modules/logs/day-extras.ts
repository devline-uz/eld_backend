/**
 * MR-12 / MR-13 / MR-16 — read-only extras of a RODS day for the driver app (`GET /mobile/logs`,
 * the offline inspection packet). Pure on purpose: no Prisma, no Nest.
 *
 *  - `annotateSegments`: each graph segment carries the §395 record that opened it (location
 *    description, odometer, engine hours, annotation, id) — §395.8(d)/Appendix A fields the
 *    grid needs to print the "remarks" lines.
 *  - `dayIndicators`: Appendix A "malfunction indicator status" / "data diagnostic event
 *    indicator status", rolled up per day (true when one was in force at any instant of it).
 *  - `tripBlockForDay`: §395.8(d)(11)-(12) shipping document / trailer numbers of the day.
 */
import { activeRecords, type RodsEvent, type RodsSegment } from './rods';

/** The `EldEvent` columns the extras read (structural, so tests need no Prisma model). */
export interface ExtrasEvent extends RodsEvent {
  totalEngineHours?: unknown;
  malfunctionCode?: string | null;
  diagnosticCode?: string | null;
}

export interface AnnotatedSegment extends RodsSegment {
  /** Id of the active record that opened this status (may lie before the day: carried over). */
  eventId: string | null;
  /** §395 location description of that record (FMCSA style when the device sent one). */
  locationDescription: string | null;
  odometerMi: number | null;
  engineHours: number | null;
  annotation: string | null;
  /** True when the status began on an earlier RODS day and runs into this one. */
  carriedOver: boolean;
}

const DUTY = 1;
const SPECIAL = 3;
const MALFUNCTION_DIAGNOSTIC = 7;

/** MR-13 — every segment gets the fields of the record in force at its start. */
export function annotateSegments(segments: RodsSegment[], events: ExtrasEvent[]): AnnotatedSegment[] {
  const sources = (activeRecords(events) as ExtrasEvent[])
    .filter((event) => event.eventType === DUTY || event.eventType === SPECIAL)
    .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime() || a.eventSequenceId - b.eventSequenceId);
  // A PC/YM indication re-states the status; the duty record is the one with the location and
  // odometer, so it is preferred when both sit at the same instant.
  return segments.map((segment) => {
    const at = segment.startAt.getTime();
    let source: ExtrasEvent | undefined;
    for (const event of sources) {
      if (event.eventDateTime.getTime() > at) break;
      if (!source || event.eventDateTime.getTime() > source.eventDateTime.getTime() || event.eventType === DUTY) {
        source = event;
      }
    }
    return {
      ...segment,
      eventId: source?.id !== undefined && source?.id !== null ? String(source.id) : null,
      locationDescription: source?.locationName ?? null,
      odometerMi: source?.totalVehicleMiles ?? null,
      engineHours: toNumberOrNull(source?.totalEngineHours),
      annotation: source?.annotation ?? null,
      carriedOver: source ? source.eventDateTime.getTime() < at : false,
    };
  });
}

/**
 * MR-16 — per-day indicators. A malfunction (eventType 7 code 1, cleared by code 2) or a data
 * diagnostic (code 3, cleared by code 4) counts for the day when it was in force at the day's
 * start or logged during it; a duty record of the day that itself carries a malfunction /
 * diagnostic code (device-reported indicator) counts too. `events` must reach back far enough
 * to see the logging of a code still in force (the caller adds a malfunction lookback).
 */
export function dayIndicators(
  events: ExtrasEvent[],
  startAt: Date,
  endAt: Date,
): { malfunctionIndicator: boolean; diagnosticIndicator: boolean } {
  const start = startAt.getTime();
  const end = endAt.getTime();
  const ordered = events
    .filter((event) => event.recordStatus === 1 && event.eventDateTime.getTime() < end)
    .sort((a, b) => a.eventDateTime.getTime() - b.eventDateTime.getTime() || a.eventSequenceId - b.eventSequenceId);

  const malfunctions = new Set<string>();
  const diagnostics = new Set<string>();
  let malfunctionIndicator = false;
  let diagnosticIndicator = false;
  let crossedStart = false;

  for (const event of ordered) {
    const t = event.eventDateTime.getTime();
    if (!crossedStart && t >= start) {
      crossedStart = true;
      if (malfunctions.size) malfunctionIndicator = true;
      if (diagnostics.size) diagnosticIndicator = true;
    }
    const inDay = t >= start;
    if (event.eventType === MALFUNCTION_DIAGNOSTIC) {
      const malKey = event.malfunctionCode ?? '*';
      const diagKey = event.diagnosticCode ?? '*';
      if (event.eventCode === 1) {
        malfunctions.add(malKey);
        if (inDay) malfunctionIndicator = true;
      } else if (event.eventCode === 2) {
        if (event.malfunctionCode) malfunctions.delete(malKey);
        else malfunctions.clear();
      } else if (event.eventCode === 3) {
        diagnostics.add(diagKey);
        if (inDay) diagnosticIndicator = true;
      } else if (event.eventCode === 4) {
        if (event.diagnosticCode) diagnostics.delete(diagKey);
        else diagnostics.clear();
      }
      continue;
    }
    if (inDay && event.malfunctionCode) malfunctionIndicator = true;
    if (inDay && event.diagnosticCode) diagnosticIndicator = true;
  }
  if (!crossedStart) {
    if (malfunctions.size) malfunctionIndicator = true;
    if (diagnostics.size) diagnosticIndicator = true;
  }
  return { malfunctionIndicator, diagnosticIndicator };
}

/** The `Trip` columns the per-day block reads. */
export interface DayTrip {
  id: string;
  number: string;
  status: string;
  shippingDocument: string | null;
  shippingDocuments: string[];
  trailerNumbers: string[];
  /** Number of the trip's `trailerId` trailer — fallback for rows written before MR-4. */
  trailerNumber?: string | null;
  bobtail: boolean;
  notes: string | null;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt?: Date | null;
}

export interface DayTripBlock {
  shippingDocuments: string[];
  trailerNumbers: string[];
  notes: string | null;
  bobtail: boolean;
  tripIds: string[];
  tripNumbers: string[];
}

const TERMINAL = new Set(['DELIVERED', 'CANCELLED']);

/**
 * MR-12 — the shipping documents / trailers of every trip of the driver that overlaps the day
 * (union, in trip start order), plus the latest trip's notes. A trip spans
 * `[startedAt ?? plannedStartAt ?? createdAt, completedAt ?? (terminal ? plannedEndAt ?? updatedAt : now))`;
 * `DRAFT` and `CANCELLED` trips never count. Always an object (empty lists when no trip).
 */
export function tripBlockForDay(trips: DayTrip[], startAt: Date, endAt: Date, now: Date): DayTripBlock {
  const overlapping = trips
    .filter((trip) => trip.status !== 'DRAFT' && trip.status !== 'CANCELLED')
    .map((trip) => ({ trip, span: tripSpan(trip, now) }))
    .filter(({ span }) => span.from < endAt.getTime() && span.to > startAt.getTime())
    .sort((a, b) => a.span.from - b.span.from);

  const docs: string[] = [];
  const trailers: string[] = [];
  for (const { trip } of overlapping) {
    const tripDocs = trip.shippingDocuments.length ? trip.shippingDocuments : trip.shippingDocument ? [trip.shippingDocument] : [];
    const tripTrailers = trip.trailerNumbers.length ? trip.trailerNumbers : trip.trailerNumber ? [trip.trailerNumber] : [];
    for (const doc of tripDocs) if (!docs.includes(doc)) docs.push(doc);
    for (const trailer of tripTrailers) if (!trailers.includes(trailer)) trailers.push(trailer);
  }
  const last = overlapping[overlapping.length - 1]?.trip;
  return {
    shippingDocuments: docs,
    trailerNumbers: trailers,
    notes: last?.notes ?? null,
    bobtail: overlapping.length > 0 && trailers.length === 0 && overlapping.some(({ trip }) => trip.bobtail),
    tripIds: overlapping.map(({ trip }) => trip.id),
    tripNumbers: overlapping.map(({ trip }) => trip.number),
  };
}

function tripSpan(trip: DayTrip, now: Date): { from: number; to: number } {
  const from = (trip.startedAt ?? trip.plannedStartAt ?? trip.createdAt).getTime();
  let to: number;
  if (trip.completedAt) to = trip.completedAt.getTime();
  else if (TERMINAL.has(trip.status)) to = (trip.plannedEndAt ?? trip.updatedAt ?? now).getTime();
  else to = now.getTime();
  return { from, to: Math.max(from, to) };
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
