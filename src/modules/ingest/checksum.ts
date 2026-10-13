import { createHash } from 'node:crypto';

/**
 * TZ §7.3 rule 4 / §23 — "every event carries a checksum and it is verified".
 *
 * The TZ shows a checksum field on the wire (`"checksum": "a3f9..."`) but does not name an
 * algorithm, so this file DEFINES the canonical one for the OneBook gateway protocol; the
 * Flutter app computes the same string over the same fields before sending. See decisions.md.
 *
 * Two properties matter for compliance:
 *   1. The checksum covers the RAW values the device reported (raw coordinates, raw metric
 *      odometer), because it must detect corruption on the BLE/HTTP path — i.e. it is computed
 *      and verified BEFORE the location is coarsened and the units are converted.
 *   2. The value stored on `EldEvent.checksum` is always the one computed HERE, so a stored
 *      record can be re-verified later even if the app sent a corrupt one. A mismatch is never
 *      a rejection: the event is stored, diagnostic `3` is attached, the batch answers 202.
 *      A MISSING checksum (B-165) is not a mismatch: no diagnostic, informational warning only.
 */

export const CHECKSUM_ALGORITHM = 'sha256/16';

export interface ChecksumFields {
  uuid: string;
  eventType: number;
  eventCode: number;
  /** UTC instant as reported by the device. */
  eventDateTime: Date | string;
  timezoneOffset: number;
  recordOrigin: number;
  recordStatus?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  rawDeviceOdometerKm?: number | null;
  totalEngineHours?: number | null;
}

function iso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function num(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined ? '' : value.toFixed(digits);
}

/** The exact string the hash is taken over — exported so the mobile team can conform to it. */
export function canonicalString(fields: ChecksumFields): string {
  return [
    fields.uuid,
    fields.eventType,
    fields.eventCode,
    iso(fields.eventDateTime),
    fields.timezoneOffset,
    fields.recordOrigin,
    fields.recordStatus ?? 1,
    num(fields.latitude, 6),
    num(fields.longitude, 6),
    num(fields.rawDeviceOdometerKm, 0),
    num(fields.totalEngineHours, 2),
  ].join('|');
}

/** 16 lowercase hex chars of SHA-256 over `canonicalString` (64 bits — plenty for corruption). */
export function computeChecksum(fields: ChecksumFields): string {
  return createHash('sha256').update(canonicalString(fields), 'utf8').digest('hex').slice(0, 16);
}

export interface ChecksumVerdict {
  /** The value that gets stored on the event. */
  expected: string;
  /** What the app sent, if anything. */
  supplied?: string;
  /**
   * False ONLY when the app sent a value and it disagrees (§7.8 diagnostic 3). B-165: an absent
   * checksum is not corruption evidence — the PT30 SDK has no checksum field — so `MISSING` is
   * `ok: true` and only an informational warning; the server-computed value is stored either way.
   */
  ok: boolean;
  reason?: 'MISSING' | 'MISMATCH';
}

export function verifyChecksum(fields: ChecksumFields, supplied?: string | null): ChecksumVerdict {
  const expected = computeChecksum(fields);
  if (supplied === undefined || supplied === null || supplied.trim() === '') {
    return { expected, ok: true, reason: 'MISSING' };
  }
  const normalized = supplied.trim().toLowerCase();
  return normalized === expected
    ? { expected, supplied: normalized, ok: true }
    : { expected, supplied: normalized, ok: false, reason: 'MISMATCH' };
}
