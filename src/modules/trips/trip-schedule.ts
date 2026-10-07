import type { TripStatus } from '@prisma/client';

/**
 * Unit (vehicle) double-booking rules for the web-panel dispatch flow (`/trips`, TZ §11.5).
 * Pure functions — the service feeds them rows, the spec feeds them fixtures.
 *
 * Which trips occupy a unit:
 *  - DRAFT / PLANNED / ASSIGNED — `plannedStartAt` → `plannedEndAt`; no planned end = open-ended.
 *    A draft counts: the web board lists it under `Scheduled` (DRAFT ∪ PLANNED) with its unit,
 *    and it publishes in place, so it reserves the unit like a planned trip.
 *  - IN_PROGRESS — `startedAt ?? plannedStartAt` → `plannedEndAt`, stretched to "now" while it
 *    overruns; no planned end = open-ended (it is on the road until delivered).
 *  - DELIVERED — the actual `startedAt` → `completedAt` (planned values as a fallback).
 *  - CANCELLED never occupies a unit.
 * A trip with no start at all cannot be placed on the timeline and is ignored.
 */

/** Statuses whose trip can block another one on the same unit. */
export const UNIT_BLOCKING_STATUSES: TripStatus[] = ['DRAFT', 'PLANNED', 'ASSIGNED', 'IN_PROGRESS', 'DELIVERED'];

/** Statuses of a trip that must not be double-booked when its unit or time range changes. */
export const UNIT_SCHEDULED_STATUSES: TripStatus[] = ['DRAFT', 'PLANNED', 'ASSIGNED', 'IN_PROGRESS'];

/** A half-open interval `[start, end)`; `end: null` means open-ended. */
export interface TimeWindow {
  start: Date;
  end: Date | null;
}

export interface ScheduledTripLike {
  id: string;
  number: string;
  status: TripStatus;
  plannedStartAt: Date | null;
  plannedEndAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** The time range a trip occupies its unit for, or `null` when it occupies nothing. */
export function occupancyOf(trip: ScheduledTripLike, now: Date = new Date()): TimeWindow | null {
  switch (trip.status) {
    case 'DRAFT':
    case 'PLANNED':
    case 'ASSIGNED':
      return trip.plannedStartAt ? { start: trip.plannedStartAt, end: trip.plannedEndAt } : null;
    case 'IN_PROGRESS': {
      const start = trip.startedAt ?? trip.plannedStartAt ?? now;
      if (!trip.plannedEndAt) return { start, end: null };
      return { start, end: trip.plannedEndAt > now ? trip.plannedEndAt : now };
    }
    case 'DELIVERED': {
      const start = trip.startedAt ?? trip.plannedStartAt;
      const end = trip.completedAt ?? trip.plannedEndAt;
      return start && end ? { start, end } : null;
    }
    default:
      return null;
  }
}

/** `a.start < b.end && a.end > b.start`; touching endpoints do not overlap, `null` end = +∞. */
export function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  const aEndsAfterBStarts = a.end === null || a.end.getTime() > b.start.getTime();
  const aStartsBeforeBEnds = b.end === null || a.start.getTime() < b.end.getTime();
  return aEndsAfterBStarts && aStartsBeforeBEnds;
}

/** The first candidate (other than `excludeTripId`) that overlaps `window`, with its range. */
export function findScheduleConflict<T extends ScheduledTripLike>(
  window: TimeWindow,
  candidates: T[],
  excludeTripId?: string,
  now: Date = new Date(),
): { trip: T; window: TimeWindow } | null {
  for (const trip of candidates) {
    if (trip.id === excludeTripId) continue;
    const occupied = occupancyOf(trip, now);
    if (occupied && windowsOverlap(window, occupied)) return { trip, window: occupied };
  }
  return null;
}

/** `2026-10-08 14:00 UTC` — the server has no viewer timezone; the web panel re-renders it. */
export function formatScheduleInstant(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
