/**
 * D-129 — trailers / shipping documents per RODS day for the eRODS file (header lines 3/4 and
 * engine power rows): the trips overlapping each day merged with the driver's no-trip day
 * details, the SAME rule `GET /mobile/logs` uses (`logs/day-extras.ts`). Shared by
 * `TransfersService` and the FMCSA compliance pack so both producers write identical headers.
 */
import { addDays, dayEnd, dayKey, dayStart } from '../hos/engine/timezone';
import { mergeDayDetails, tripBlockForDay } from '../logs/day-extras';
import type { TripDetails } from './snapshot';
import type { TransfersRepository } from './transfers.repository';

export interface RangeTripDetails {
  /** The set in force for the header: the generation day, or the range's last day for a past range. */
  current: TripDetails | null;
  byDay: Record<string, TripDetails>;
}

export async function loadTripDetails(
  repo: Pick<TransfersRepository, 'findDayTrips' | 'findDayDetails'>,
  driverId: string,
  timezone: string,
  fromKey: string,
  toKey: string,
  generatedAt: Date,
): Promise<RangeTripDetails> {
  const [trips, details] = await Promise.all([
    repo.findDayTrips(driverId, dayStart(timezone, fromKey), dayEnd(timezone, toKey)),
    repo.findDayDetails(driverId, new Date(`${fromKey}T00:00:00.000Z`), new Date(`${toKey}T00:00:00.000Z`)),
  ]);
  const detailsByKey = new Map(details.map((row) => [dayKey('UTC', row.logDate), row]));
  const byDay: Record<string, TripDetails> = {};
  for (let key = fromKey; key <= toKey; key = addDays(key, 1)) {
    const block = mergeDayDetails(tripBlockForDay(trips, dayStart(timezone, key), dayEnd(timezone, key), generatedAt), detailsByKey.get(key));
    byDay[key] = { trailerNumbers: block.trailerNumbers, shippingDocuments: block.shippingDocuments };
  }
  const todayKey = dayKey(timezone, generatedAt);
  const currentKey = todayKey < toKey ? todayKey : toKey;
  return { current: byDay[currentKey] ?? null, byDay };
}
