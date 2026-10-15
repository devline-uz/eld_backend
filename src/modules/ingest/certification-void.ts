import { dayEnd, dayStart } from '../hos/engine/timezone';
import { EVENT_TYPE } from './event-codes';

/**
 * §395.30(b)-(c) / TZ §9.2 / bugs.md B-123 (user decision: certify option b) — a driver may
 * certify a RODS day at any time, but a record that lands on that day AFTER the signature voids
 * it, so the day reads "re-certification required" (`certified = false`, `certificationCount`
 * kept). The edit paths already do this through `LogsService.recordLogChange`; this covers the
 * gateway: duty-status, intermediate and PC/YM records that arrive late (offline sync) or after an
 * early signature (certified at 02:18, then drove on).
 *
 * Login/logout, engine power, malfunction/diagnostic and certification records never void a
 * signature — a driver who certifies and then logs out must not be asked to sign again.
 */
const VOIDING_EVENT_TYPES: ReadonlySet<number> = new Set([
  EVENT_TYPE.DUTY_STATUS_CHANGE,
  EVENT_TYPE.INTERMEDIATE_LOG,
  EVENT_TYPE.PC_YM_INDICATION,
]);

export interface IngestedRecord {
  driverId: string | null | undefined;
  eventType: number;
  recordStatus?: number | null;
  at: Date;
  /** Driving nobody owns yet — it becomes an unidentified segment, not the driver's record. */
  unidentified: boolean;
}

export interface CertifiedHeader {
  id: string;
  driverId: string;
  /** The RODS day as a UTC calendar date (`@db.Date`). */
  logDate: Date;
  /** The home-terminal zone the day was split in. */
  timezone: string;
  /** When the driver signed. Null only on legacy rows — those keep the "any record voids" rule. */
  certifiedAt: Date | null;
}

/** Drivers whose fresh records can void a signature, with the instants to test. */
export function voidingInstantsByDriver(records: IngestedRecord[]): Map<string, Date[]> {
  const out = new Map<string, Date[]>();
  for (const record of records) {
    if (!record.driverId || record.unidentified) continue;
    if (!VOIDING_EVENT_TYPES.has(record.eventType)) continue;
    if ((record.recordStatus ?? 1) !== 1) continue;
    const list = out.get(record.driverId) ?? [];
    list.push(record.at);
    out.set(record.driverId, list);
  }
  return out;
}

/**
 * The certified headers whose RODS day (in its own zone) holds at least one of the instants
 * recorded AFTER the signature. A record dated before `certifiedAt` was already on the driver's
 * device when they signed and merely reached the server late (offline queue) — it does not change
 * what was certified, so it must not void it (§395.30: re-certify when records change after signing).
 */
export function headersToVoid(headers: CertifiedHeader[], instants: Date[]): CertifiedHeader[] {
  return headers.filter((header) => {
    const key = header.logDate.toISOString().slice(0, 10);
    const start = dayStart(header.timezone, key).getTime();
    const end = dayEnd(header.timezone, key).getTime();
    const signedAt = header.certifiedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    return instants.some((at) => at.getTime() >= start && at.getTime() < end && at.getTime() > signedAt);
  });
}
