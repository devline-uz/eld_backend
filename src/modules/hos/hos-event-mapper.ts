/**
 * TZ §5.5 / §8.3 step 1 — turns stored §395 records into the engine's `NormalizedEvent`s.
 *
 * Pure on purpose: it takes a structural row shape, not a Prisma model, so the engine package
 * still imports nothing. Two record families matter here:
 *   eventType 1 — duty status change (eventCode 1..4 → OFF/SB/D/ON)
 *   eventType 3 — PC/YM indication (eventCode 0 cleared, 1 personal conveyance, 2 yard move)
 * A PC/YM indication STAYS in force until it is cleared or the driver changes duty status to
 * one that cannot carry it, so the category is carried forward, not read off a single row.
 */
import type { DutyStatus, NormalizedEvent, SpecialDrivingCategory } from './hos.types';

export interface EldEventRow {
  eventType: number;
  eventCode: number;
  eventDateTime: Date;
  recordStatus?: number;
  eventSequenceId?: number;
  locationPrecisionMi?: number | null;
}

const DUTY_BY_CODE: Record<number, DutyStatus> = { 1: 'OFF', 2: 'SB', 3: 'D', 4: 'ON' };
const SPECIAL_BY_CODE: Record<number, SpecialDrivingCategory> = { 0: 'NONE', 1: 'PC', 2: 'YM' };

export const EVENT_TYPE_DUTY_STATUS = 1;
export const EVENT_TYPE_PC_YM = 3;

export function mapEldEventsToNormalized(rows: EldEventRow[]): NormalizedEvent[] {
  const ordered = rows
    .filter((row) => (row.recordStatus ?? 1) === 1)
    .slice()
    .sort((a, b) => {
      const byTime = a.eventDateTime.getTime() - b.eventDateTime.getTime();
      return byTime !== 0 ? byTime : (a.eventSequenceId ?? 0) - (b.eventSequenceId ?? 0);
    });

  const events: NormalizedEvent[] = [];
  let status: DutyStatus | null = null;
  let special: SpecialDrivingCategory = 'NONE';

  for (const row of ordered) {
    if (row.eventType === EVENT_TYPE_PC_YM) {
      special = SPECIAL_BY_CODE[row.eventCode] ?? 'NONE';
      // An indication on its own re-states the current duty status under a new category.
      if (status === null) continue;
      events.push({
        at: row.eventDateTime,
        status,
        special,
        eventSequenceId: row.eventSequenceId,
        locationPrecisionMi: row.locationPrecisionMi ?? undefined,
      });
      continue;
    }
    if (row.eventType !== EVENT_TYPE_DUTY_STATUS) continue;
    const next = DUTY_BY_CODE[row.eventCode];
    if (!next) continue;
    status = next;
    // Driving and on-duty records clear a stale PC indication: PC cannot survive a move back
    // to D, and YM cannot survive a move to OFF/SB.
    if ((special === 'PC' && next !== 'OFF') || (special === 'YM' && next !== 'ON' && next !== 'D')) {
      special = 'NONE';
    }
    events.push({
      at: row.eventDateTime,
      status,
      special,
      eventSequenceId: row.eventSequenceId,
      locationPrecisionMi: row.locationPrecisionMi ?? undefined,
    });
  }
  return events;
}
